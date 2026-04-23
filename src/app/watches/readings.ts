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
// Slice #17 (issue #18): verified readings — camera-captured + AI-read.
// -------------------------------------------------------------------
//
// The backend (slice #16) accepts a multipart body with an `image`
// file and an optional `is_baseline` toggle. It returns 201 with the
// full reading row on success, 422 on AI refusal / implausible / un-
// parseable output, 503 when the `ai_reading_v2` feature flag is off
// for the caller, and the usual 4xx auth/ownership codes.
//
// We don't surface the verifier's raw_response to the SPA — the
// mapped message in verifiedReadingErrors.ts is enough. If we ever
// want debug info in the UI, we'll plumb it through separately.

export interface VerifiedReadingSubmission {
  image: File;
  isBaseline: boolean;
}

export async function createVerifiedReading(
  watchId: string,
  submission: VerifiedReadingSubmission,
): Promise<
  { ok: true; reading: Reading } | { ok: false; error: VerifiedReadingErrorMessage }
> {
  const form = new FormData();
  form.append("image", submission.image);
  form.append("is_baseline", submission.isBaseline ? "true" : "false");

  const response = await fetch(
    `/api/v1/watches/${encodeURIComponent(watchId)}/readings/verified`,
    {
      method: "POST",
      body: form,
      credentials: "include",
    },
  );
  if (!response.ok) {
    let serverCode: string | undefined;
    try {
      const parsed = (await response.json()) as { error?: string };
      serverCode = parsed.error;
    } catch {
      /* non-JSON body */
    }
    return { ok: false, error: mapVerifiedReadingError(response.status, serverCode) };
  }
  const reading = (await response.json()) as Reading;
  return { ok: true, reading };
}
