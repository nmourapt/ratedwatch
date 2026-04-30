// HTTP client for /api/v1/watches/:id/readings + /api/v1/readings/:id.
// Mirrors the shape conventions in src/app/watches/api.ts: every call
// returns a discriminated union so the pages don't leak raw Response
// objects into render code.
//
// The Reading / SessionStats wire shapes are kept lightweight here;
// the shared Zod schemas on the server side are the contract source
// of truth, these interfaces mirror them.

import {
  mapVerifiedReadingError,
  type VerifiedReadingErrorMessage,
} from "./verifiedReadingErrors";

export interface Reading {
  id: string;
  watch_id: string;
  user_id: string;
  /** Unix ms. */
  reference_timestamp: number;
  deviation_seconds: number;
  is_baseline: boolean;
  verified: boolean;
  notes: string | null;
  created_at: string;
}

export interface PerIntervalDrift {
  from_reading_id: string;
  to_reading_id: string;
  interval_days: number;
  drift_rate_spd: number;
}

export interface SessionStats {
  session_days: number;
  reading_count: number;
  verified_ratio: number;
  avg_drift_rate_spd: number | null;
  per_interval: PerIntervalDrift[];
  eligible: boolean;
  verified_badge: boolean;
  latest_deviation_seconds: number;
  baseline_reference_timestamp: number;
}

export interface ReadingsError {
  code: "invalid_input" | "unauthorized" | "forbidden" | "not_found" | "unknown";
  message: string;
  fieldErrors?: Record<string, string>;
}

async function readError(response: Response): Promise<ReadingsError> {
  let parsed: { error?: string; fieldErrors?: Record<string, string> } = {};
  try {
    parsed = (await response.json()) as typeof parsed;
  } catch {
    /* non-JSON body */
  }
  if (response.status === 400 && parsed.error === "invalid_input") {
    const fieldErrors = parsed.fieldErrors ?? {};
    const firstMsg =
      Object.values(fieldErrors)[0] ?? "Please check the form and try again";
    return { code: "invalid_input", message: firstMsg, fieldErrors };
  }
  if (response.status === 401) {
    return { code: "unauthorized", message: "Your session has expired" };
  }
  if (response.status === 403) {
    return { code: "forbidden", message: "You do not own this reading" };
  }
  if (response.status === 404) {
    return { code: "not_found", message: "Not found" };
  }
  return {
    code: "unknown",
    message: `Request failed with status ${response.status}`,
  };
}

export async function listReadings(
  watchId: string,
): Promise<
  | { ok: true; readings: Reading[]; session_stats: SessionStats | null }
  | { ok: false; error: ReadingsError }
> {
  const response = await fetch(
    `/api/v1/watches/${encodeURIComponent(watchId)}/readings`,
    { credentials: "include" },
  );
  if (!response.ok) return { ok: false, error: await readError(response) };
  const body = (await response.json()) as {
    readings: Reading[];
    session_stats: SessionStats | null;
  };
  return { ok: true, readings: body.readings, session_stats: body.session_stats };
}

export interface CreateReadingBody {
  reference_timestamp: number;
  deviation_seconds: number;
  is_baseline?: boolean;
  notes?: string;
}

export async function createReading(
  watchId: string,
  body: CreateReadingBody,
): Promise<{ ok: true; reading: Reading } | { ok: false; error: ReadingsError }> {
  const response = await fetch(
    `/api/v1/watches/${encodeURIComponent(watchId)}/readings`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) return { ok: false, error: await readError(response) };
  const reading = (await response.json()) as Reading;
  return { ok: true, reading };
}

/**
 * Wire body for the tap-reading flow. Reference time is server-side,
 * so there's no `reference_timestamp` here — the server uses its own
 * `Date.now()` at request receipt and computes the deviation.
 */
export interface CreateTapReadingBody {
  dial_position: 0 | 15 | 30 | 45;
  is_baseline?: boolean;
  notes?: string;
}

export async function createTapReading(
  watchId: string,
  body: CreateTapReadingBody,
): Promise<{ ok: true; reading: Reading } | { ok: false; error: ReadingsError }> {
  const response = await fetch(
    `/api/v1/watches/${encodeURIComponent(watchId)}/readings/tap`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) return { ok: false, error: await readError(response) };
  const reading = (await response.json()) as Reading;
  return { ok: true, reading };
}

export async function deleteReading(
  id: string,
): Promise<{ ok: true } | { ok: false; error: ReadingsError }> {
  const response = await fetch(`/api/v1/readings/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) return { ok: false, error: await readError(response) };
  return { ok: true };
}

// -------------------------------------------------------------------
// Verified readings — two-step API.
// -------------------------------------------------------------------
//
// Slice #17 (issue #18) introduced the synchronous
// `POST /readings/verified` route. Slice #6 of PRD #99 (issue #105)
// split it in two for the anti-cheat UX:
//
//   1. POST /readings/verified/draft   — accepts the photo, runs
//      the VLM pipeline, returns a signed `reading_token` + the
//      predicted MM:SS + a photo URL + the server-clock hour.
//      Does NOT save a reading row.
//   2. POST /readings/verified/confirm — accepts
//      { reading_token, final_mm_ss, is_baseline? }. Validates the
//      token + the ±30s adjustment cap, saves the reading row,
//      moves the photo from drafts/ to verified/.
//
// Anti-cheat property: /draft never returns the deviation. The SPA
// confirmation page (slice #7 — issue #106) lets the user adjust ±
// seconds without seeing what deviation it would produce, so an
// honest read is the user's dominant strategy.
//
// We don't surface the verifier's raw_response to the SPA — the
// mapped message in verifiedReadingErrors.ts is enough. If we ever
// want debug info in the UI, we'll plumb it through separately.

export interface VerifiedReadingDraftSubmission {
  image: File;
  /**
   * Optional client-supplied photo-capture timestamp (unix ms). PR
   * #124 fix for the verified-reading upload-latency bias: the SPA
   * extracts this from EXIF DateTimeOriginal on the ORIGINAL bytes
   * (or `Date.now()` at file-selection moment as a fallback) before
   * canvas-resize destroys the EXIF. The server bounds it (±5 min /
   * +1 min vs arrival) and uses it as the reference. Same anti-cheat
   * envelope as byte-EXIF.
   */
  clientCaptureMs?: number;
  /**
   * Optional client TZ offset in MINUTES east of UTC (Lisbon WEST =
   * +60, NYC EDT = −240). PR #126 fix for the TZ-bias-as-deviation
   * report: a watch displaying local time was being compared
   * against a UTC-derived reference, baking 3600 s of TZ offset
   * into every reading. When this field is present, the server
   * shifts the reference into the user's local-clock frame before
   * extracting H/M/S, so deviation reflects watch-vs-local-clock.
   *
   * Captured as `-new Date(captureMs).getTimezoneOffset()` so it's
   * DST-aware for the moment of capture. Server bounds: ±840 min.
   */
  clientTzOffsetMinutes?: number;
}

/**
 * Wire shape of the /draft 200 response. Mirrors the route handler
 * in src/server/routes/readings.ts. Critically, this object does NOT
 * include the deviation — see anti-cheat note above.
 *
 * PR #122 reworked this from `predicted_mm_ss` + separate
 * `hour_from_server_clock` (24-hour UTC) into a single
 * `predicted_hms` (12-hour analog) so the SPA's confirmation page
 * can pre-populate per-component up/down adjusters in a single
 * step.
 */
export interface VerifiedReadingDraft {
  reading_token: string;
  predicted_hms: { h: number; m: number; s: number };
  photo_url: string;
  reference_source: "exif" | "server" | "client";
  expires_at_unix: number;
}

async function readVerifiedError(
  response: Response,
): Promise<VerifiedReadingErrorMessage> {
  let serverCode: string | undefined;
  try {
    // The CV pipeline emits `{ error_code, ux_hint }`; legacy errors
    // (e.g. `image_required`) emit `{ error }`. Prefer error_code if
    // both are present.
    const parsed = (await response.json()) as {
      error?: string;
      error_code?: string;
    };
    serverCode = parsed.error_code ?? parsed.error;
  } catch {
    /* non-JSON body */
  }
  return mapVerifiedReadingError(response.status, serverCode);
}

/**
 * POST /readings/verified/draft — upload the photo, get a signed
 * token + predicted MM:SS back. The caller hands the result to the
 * confirmation page; the user adjusts seconds and submits via
 * `confirmVerifiedReading`.
 */
export async function draftVerifiedReading(
  watchId: string,
  submission: VerifiedReadingDraftSubmission,
): Promise<
  | { ok: true; draft: VerifiedReadingDraft }
  | { ok: false; error: VerifiedReadingErrorMessage }
> {
  const form = new FormData();
  form.append("image", submission.image);
  if (submission.clientCaptureMs !== undefined) {
    // Server reads this as a multipart string and parses to number.
    // Bounds-checked against arrival on the server — sending a
    // wildly out-of-bounds value yields HTTP 422 exif_clock_skew.
    form.append("client_capture_ms", String(submission.clientCaptureMs));
  }
  if (submission.clientTzOffsetMinutes !== undefined) {
    // Server bounds: ±840 min (covers all real TZs incl. UTC+14 and
    // UTC−12 with DST variants). Out-of-bounds → HTTP 400.
    form.append("client_tz_offset_minutes", String(submission.clientTzOffsetMinutes));
  }

  const response = await fetch(
    `/api/v1/watches/${encodeURIComponent(watchId)}/readings/verified/draft`,
    {
      method: "POST",
      body: form,
      credentials: "include",
    },
  );
  if (!response.ok) {
    return { ok: false, error: await readVerifiedError(response) };
  }
  const draft = (await response.json()) as VerifiedReadingDraft;
  return { ok: true, draft };
}

export interface ConfirmVerifiedReadingSubmission {
  reading_token: string;
  /**
   * Full HH:MM:SS the user is asserting their watch displays
   * (12-hour analog clock — h ∈ [1, 12], m/s ∈ [0, 59]). PR #122
   * replaced the seconds-only `final_mm_ss` to support
   * per-component adjustment.
   */
  final_hms: { h: number; m: number; s: number };
  is_baseline?: boolean;
}

/**
 * POST /readings/verified/confirm — submit the user's (possibly
 * adjusted) MM:SS for saving. Server validates the token signature
 * + ±30s adjustment cap and returns the saved reading row.
 */
export async function confirmVerifiedReading(
  watchId: string,
  submission: ConfirmVerifiedReadingSubmission,
): Promise<
  { ok: true; reading: Reading } | { ok: false; error: VerifiedReadingErrorMessage }
> {
  const response = await fetch(
    `/api/v1/watches/${encodeURIComponent(watchId)}/readings/verified/confirm`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(submission),
      credentials: "include",
    },
  );
  if (!response.ok) {
    return { ok: false, error: await readVerifiedError(response) };
  }
  const reading = (await response.json()) as Reading;
  return { ok: true, reading };
}

// Slice #80 (PRD #73 User Story #10): manual_with_photo fallback.
//
// Called when the dial reader rejects a verified-reading photo and
// the user clicks "Enter manually". The SPA submits the SAME
// already-captured photo plus the user's typed HH:MM:SS. The
// server persists a manual reading row (verified=0) with the photo
// alongside it.

export interface ManualWithPhotoSubmission {
  image: File;
  hh: number;
  mm: number;
  ss: number;
  isBaseline: boolean;
  notes?: string;
}

export async function createManualWithPhotoReading(
  watchId: string,
  submission: ManualWithPhotoSubmission,
): Promise<
  { ok: true; reading: Reading } | { ok: false; error: VerifiedReadingErrorMessage }
> {
  const form = new FormData();
  form.append("image", submission.image);
  form.append("hh", String(submission.hh));
  form.append("mm", String(submission.mm));
  form.append("ss", String(submission.ss));
  form.append("is_baseline", submission.isBaseline ? "true" : "false");
  if (submission.notes !== undefined) {
    form.append("notes", submission.notes);
  }
  const response = await fetch(
    `/api/v1/watches/${encodeURIComponent(watchId)}/readings/manual_with_photo`,
    {
      method: "POST",
      body: form,
      credentials: "include",
    },
  );
  if (!response.ok) {
    let serverCode: string | undefined;
    try {
      const parsed = (await response.json()) as {
        error?: string;
        error_code?: string;
      };
      serverCode = parsed.error_code ?? parsed.error;
    } catch {
      /* non-JSON */
    }
    return {
      ok: false,
      error: mapVerifiedReadingError(response.status, serverCode),
    };
  }
  const reading = (await response.json()) as Reading;
  return { ok: true, reading };
}
