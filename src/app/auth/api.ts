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
