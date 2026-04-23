// HTTP client for /api/v1/watches. Same shape conventions as
// src/app/auth/api.ts — every call returns a discriminated union so
// the pages never leak raw Response objects into render code.
//
// Types are kept lightweight; the shared Zod schemas in
// src/schemas/watch.ts are the source of truth for the wire contract,
// and these interfaces mirror them.

export interface Watch {
  id: string;
  user_id: string;
  name: string;
  brand: string | null;
  model: string | null;
  movement_id: string | null;
  movement_canonical_name: string | null;
  custom_movement_name: string | null;
  notes: string | null;
  is_public: boolean;
  created_at: string;
  // Slice #10 (issue #11). Non-null when a photo has been uploaded.
  // The SPA renders the <img> only when this is set; the src still
  // points at the stable /images/watches/:id route.
  image_r2_key: string | null;
}

/**
 * Slice #18: session summary embedded in watch list responses so the
 * dashboard can render the verified progress ring per-card without a
 * second round-trip. Only returned from the list endpoint; individual
 * GET /watches/:id still returns the bare Watch shape.
 */
export interface WatchSessionSummary {
  session_days: number;
  reading_count: number;
  verified_ratio: number;
  avg_drift_rate_spd: number | null;
  eligible: boolean;
  verified_badge: boolean;
  latest_deviation_seconds: number;
  baseline_reference_timestamp: number;
}

export interface WatchWithSession extends Watch {
  session_stats: WatchSessionSummary;
}

export interface WatchError {
  code:
    | "invalid_input"
    | "invalid_movement"
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "unknown";
  message: string;
  fieldErrors?: Record<string, string>;
}

async function readWatchError(response: Response): Promise<WatchError> {
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
  if (response.status === 400 && parsed.error === "invalid_movement") {
    return { code: "invalid_movement", message: "Please pick a valid movement" };
  }
  if (response.status === 401) {
    return { code: "unauthorized", message: "Your session has expired" };
  }
  if (response.status === 403) {
    return { code: "forbidden", message: "You do not own this watch" };
  }
  if (response.status === 404) {
    return { code: "not_found", message: "Watch not found" };
  }
  return {
    code: "unknown",
    message: `Request failed with status ${response.status}`,
  };
}

export async function listWatches(): Promise<
  { ok: true; watches: WatchWithSession[] } | { ok: false; error: WatchError }
> {
  const response = await fetch("/api/v1/watches", { credentials: "include" });
  if (!response.ok) return { ok: false, error: await readWatchError(response) };
  const body = (await response.json()) as { watches: WatchWithSession[] };
  return { ok: true, watches: body.watches };
}

export async function getWatch(
  id: string,
): Promise<{ ok: true; watch: Watch } | { ok: false; error: WatchError }> {
  const response = await fetch(`/api/v1/watches/${encodeURIComponent(id)}`, {
    credentials: "include",
  });
  if (!response.ok) return { ok: false, error: await readWatchError(response) };
  const watch = (await response.json()) as Watch;
  return { ok: true, watch };
}

export interface CreateWatchBody {
  name: string;
  brand?: string;
  model?: string;
  movement_id: string;
  custom_movement_name?: string;
  notes?: string;
  is_public?: boolean;
}

export async function createWatch(
  body: CreateWatchBody,
): Promise<{ ok: true; watch: Watch } | { ok: false; error: WatchError }> {
  const response = await fetch("/api/v1/watches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!response.ok) return { ok: false, error: await readWatchError(response) };
  const watch = (await response.json()) as Watch;
  return { ok: true, watch };
}

export type UpdateWatchBody = Partial<CreateWatchBody>;

export async function updateWatch(
  id: string,
  body: UpdateWatchBody,
): Promise<{ ok: true; watch: Watch } | { ok: false; error: WatchError }> {
  const response = await fetch(`/api/v1/watches/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!response.ok) return { ok: false, error: await readWatchError(response) };
  const watch = (await response.json()) as Watch;
  return { ok: true, watch };
}

export async function deleteWatch(
  id: string,
): Promise<{ ok: true } | { ok: false; error: WatchError }> {
  const response = await fetch(`/api/v1/watches/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) return { ok: false, error: await readWatchError(response) };
  return { ok: true };
}

// Thin wrapper around the movements typeahead endpoint. Used by the
// add/edit forms; kept beside the watches API because movements is
// where the UX lives even though the API lives at /api/v1/movements.
export interface MovementOption {
  id: string;
  canonical_name: string;
  manufacturer: string;
  caliber: string;
  type: string;
  status: string;
}

export async function searchMovements(
  query: string,
  signal?: AbortSignal,
): Promise<{ approved: MovementOption[]; suggestions: MovementOption[] }> {
  const qs = new URLSearchParams({ q: query, limit: "10" });
  const response = await fetch(`/api/v1/movements?${qs.toString()}`, {
    credentials: "include",
    signal,
  });
  if (!response.ok) {
    // Swallow errors in the typeahead — an empty list is the right UI
    // for "something went sideways mid-keystroke".
    return { approved: [], suggestions: [] };
  }
  const body = (await response.json()) as {
    approved: MovementOption[];
    suggestions: MovementOption[];
  };
  return {
    approved: body.approved ?? [],
    suggestions: body.suggestions ?? [],
  };
}

// Slice #10: submit a user-proposed movement. Mirrors the route's
// discriminated response:
//
//   * 201 → { status: "created", movement }
//   * 200 → { status: "exists_pending_own", movement } (idempotent)
//   * 409 → { status: "exists_approved" | "exists_pending_other", movement }
//   * 400 → { status: "invalid_input", fieldErrors }
//   * 401 → { status: "unauthorized" }
//
// Any other response collapses to { status: "unknown" } with a readable
// message so the sub-form can render it without special-casing.
export interface SubmitMovementBody {
  canonical_name: string;
  manufacturer: string;
  caliber: string;
  type: "automatic" | "manual" | "quartz" | "spring-drive" | "other";
  notes?: string;
}

export type SubmitMovementResult =
  | { status: "created"; movement: MovementOption }
  | { status: "exists_pending_own"; movement: MovementOption }
  | { status: "exists_approved"; movement: MovementOption }
  | { status: "exists_pending_other"; movement: MovementOption }
  | { status: "invalid_input"; fieldErrors: Record<string, string> }
  | { status: "unauthorized" }
  | { status: "unknown"; message: string };

export async function submitMovement(
  body: SubmitMovementBody,
): Promise<SubmitMovementResult> {
  const response = await fetch("/api/v1/movements", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });

  if (response.status === 201) {
    const json = (await response.json()) as { movement: MovementOption };
    return { status: "created", movement: json.movement };
  }
  if (response.status === 200) {
    const json = (await response.json()) as { movement: MovementOption };
    return { status: "exists_pending_own", movement: json.movement };
  }
  if (response.status === 409) {
    const json = (await response.json()) as {
      error: string;
      movement: MovementOption;
    };
    const status =
      json.error === "movement_exists_approved"
        ? "exists_approved"
        : "exists_pending_other";
    return { status, movement: json.movement };
  }
  if (response.status === 400) {
    const json = (await response.json()) as {
      error?: string;
      fieldErrors?: Record<string, string>;
    };
    return { status: "invalid_input", fieldErrors: json.fieldErrors ?? {} };
  }
  if (response.status === 401) {
    return { status: "unauthorized" };
  }
  return {
    status: "unknown",
    message: `Request failed with status ${response.status}`,
  };
}

// -------------------------------------------------------------------
// Slice #10 (issue #11): image upload + delete.
// -------------------------------------------------------------------

export type ImageUploadError = {
  code:
    | "payload_too_large"
    | "unsupported_media_type"
    | "invalid_input"
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "unknown";
  message: string;
};

/** Human-readable mapping for the server's image-upload error codes. */
function mapUploadError(status: number, errorCode?: string): ImageUploadError {
  if (status === 413) {
    return {
      code: "payload_too_large",
      message: "Image is too large — the maximum is 5 MB",
    };
  }
  if (status === 415) {
    return {
      code: "unsupported_media_type",
      message: "Unsupported image type — use JPEG, PNG, WebP, or HEIC",
    };
  }
  if (status === 400) {
    return { code: "invalid_input", message: "Please choose an image file" };
  }
  if (status === 401) {
    return { code: "unauthorized", message: "Your session has expired" };
  }
  if (status === 403) {
    return { code: "forbidden", message: "You do not own this watch" };
  }
  if (status === 404) {
    return { code: "not_found", message: "Watch not found" };
  }
  return {
    code: "unknown",
    message: errorCode
      ? `Upload failed: ${errorCode}`
      : `Upload failed with status ${status}`,
  };
}

export async function uploadWatchImage(
  watchId: string,
  file: File,
): Promise<{ ok: true; key: string } | { ok: false; error: ImageUploadError }> {
  const form = new FormData();
  form.append("image", file);
  const response = await fetch(`/api/v1/watches/${encodeURIComponent(watchId)}/image`, {
    method: "PUT",
    body: form,
    credentials: "include",
  });
  if (!response.ok) {
    let code: string | undefined;
    try {
      const parsed = (await response.json()) as { error?: string };
      code = parsed.error;
    } catch {
      /* ignore */
    }
    return { ok: false, error: mapUploadError(response.status, code) };
  }
  const body = (await response.json()) as { ok: boolean; key: string };
  return { ok: true, key: body.key };
}

export async function deleteWatchImage(
  watchId: string,
): Promise<{ ok: true } | { ok: false; error: ImageUploadError }> {
  const response = await fetch(`/api/v1/watches/${encodeURIComponent(watchId)}/image`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) {
    return { ok: false, error: mapUploadError(response.status) };
  }
  return { ok: true };
}
