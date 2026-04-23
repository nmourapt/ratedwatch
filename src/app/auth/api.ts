// Thin wrapper around the Better Auth HTTP API mounted at
// /api/v1/auth/*. The SPA shares the same origin as the Worker in
// production, so `credentials: "include"` is technically not
// required, but being explicit is safer and future-proofs us if the
// SPA ever moves off-origin.

export interface MeResponse {
  id: string;
  email: string;
  username: string | null;
}

export interface AuthError {
  message: string;
  code?: string;
}

async function readError(response: Response): Promise<AuthError> {
  try {
    const body = (await response.json()) as Partial<AuthError>;
    if (body && typeof body.message === "string") {
      return { message: body.message, code: body.code };
    }
  } catch {
    /* fall through */
  }
  return {
    message: `Request failed with status ${response.status}`,
  };
}

export async function register(body: {
  name: string;
  email: string;
  password: string;
}): Promise<{ ok: true } | { ok: false; error: AuthError }> {
  const response = await fetch("/api/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!response.ok) return { ok: false, error: await readError(response) };
  return { ok: true };
}

export async function login(body: {
  email: string;
  password: string;
}): Promise<{ ok: true } | { ok: false; error: AuthError }> {
  const response = await fetch("/api/v1/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!response.ok) return { ok: false, error: await readError(response) };
  return { ok: true };
}

/**
 * Kick off Google OAuth. Posts to Better Auth's /sign-in/social with
 * `provider: "google"`; the Worker returns either
 *   { redirect: true, url: "https://accounts.google.com/..." }
 * (the normal browser flow) or a session payload directly (only on
 * the ID-token branch, which we don't use from the SPA).
 *
 * On success we navigate the window to the returned URL so Google can
 * present its consent screen. The user will come back via
 *   /api/v1/auth/callback/google
 * which Better Auth handles internally and then redirects to
 * `callbackURL` below. We point that at /app/dashboard so a freshly
 * authed user lands on the same page as email/password signup.
 */
export async function signInWithGoogle(): Promise<
  { ok: true } | { ok: false; error: AuthError }
> {
  const response = await fetch("/api/v1/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      provider: "google",
      callbackURL: "/app/dashboard",
      errorCallbackURL: "/app/login",
    }),
  });
  if (!response.ok) return { ok: false, error: await readError(response) };
  const data = (await response.json()) as { redirect?: boolean; url?: string };
  if (data.redirect && data.url) {
    // Hard navigation — we're leaving the SPA to visit Google.
    window.location.href = data.url;
    return { ok: true };
  }
  // Unexpected shape (e.g. the Worker handled the sign-in inline);
  // fall through as "ok" and let the caller refresh /me.
  return { ok: true };
}

export async function logout(): Promise<void> {
  await fetch("/api/v1/auth/sign-out", {
    method: "POST",
    credentials: "include",
  });
}

export async function fetchMe(): Promise<MeResponse | null> {
  const response = await fetch("/api/v1/me", { credentials: "include" });
  if (response.status === 401) return null;
  if (!response.ok) {
    throw new Error(`Failed to fetch session: ${response.status}`);
  }
  return (await response.json()) as MeResponse;
}

/**
 * Result of a profile update. `field_errors` is the per-field
 * validation map returned by the API (the shape produced by
 * `formatUpdateMeErrors` on the server). `code` maps the API's
 * discriminated error:
 *   - `"username_taken"` — 409, a different user already owns that name
 *   - `"invalid_input"`  — 400, one or more fieldErrors present
 *   - `"unauthorized"`   — 401, session expired
 *   - `"unknown"`        — anything else
 */
export type UpdateMeErrorCode =
  | "username_taken"
  | "invalid_input"
  | "unauthorized"
  | "unknown";

export interface UpdateMeError {
  code: UpdateMeErrorCode;
  message: string;
  fieldErrors?: Record<string, string>;
}

export async function updateMe(body: {
  username: string;
}): Promise<{ ok: true; user: MeResponse } | { ok: false; error: UpdateMeError }> {
  const response = await fetch("/api/v1/me", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (response.ok) {
    const user = (await response.json()) as MeResponse;
    return { ok: true, user };
  }

  // The API returns { error, fieldErrors? }; map it into the shape
  // the form consumes.
  let parsed: { error?: string; fieldErrors?: Record<string, string> } = {};
  try {
    parsed = (await response.json()) as typeof parsed;
  } catch {
    /* non-JSON body (rare) — fall through to the unknown error */
  }
  if (response.status === 409 && parsed.error === "username_taken") {
    return {
      ok: false,
      error: {
        code: "username_taken",
        message: "That username is already taken",
        fieldErrors: { username: "That username is already taken" },
      },
    };
  }
  if (response.status === 400 && parsed.error === "invalid_input") {
    const fieldErrors = parsed.fieldErrors ?? {};
    const firstMsg =
      fieldErrors.username ?? Object.values(fieldErrors)[0] ?? "Invalid input";
    return {
      ok: false,
      error: { code: "invalid_input", message: firstMsg, fieldErrors },
    };
  }
  if (response.status === 401) {
    return {
      ok: false,
      error: { code: "unauthorized", message: "Your session has expired" },
    };
  }
  return {
    ok: false,
    error: {
      code: "unknown",
      message: `Request failed with status ${response.status}`,
    },
  };
}
