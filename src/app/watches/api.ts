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
  { ok: true; watches: Watch[] } | { ok: false; error: WatchError }
> {
  const response = await fetch("/api/v1/watches", { credentials: "include" });
  if (!response.ok) return { ok: false, error: await readWatchError(response) };
  const body = (await response.json()) as { watches: Watch[] };
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
): Promise<{ approved: MovementOption[] }> {
  const qs = new URLSearchParams({ q: query, limit: "10" });
  const response = await fetch(`/api/v1/movements?${qs.toString()}`, {
    credentials: "include",
    signal,
  });
  if (!response.ok) {
    // Swallow errors in the typeahead — an empty list is the right UI
    // for "something went sideways mid-keystroke".
    return { approved: [] };
  }
  const body = (await response.json()) as {
    approved: MovementOption[];
    suggestions: MovementOption[];
  };
  return { approved: body.approved ?? [] };
}
