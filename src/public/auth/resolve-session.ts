// Resolve a Better Auth session from an incoming request, returning a
// public-safe slice of the user (id + username). Used by public SSR
// pages so the header can render session-aware affordances —
// specifically: a logged-in visitor landing on a public page
// (/, /leaderboard, /m/:id, /u/:name, /w/:id) sees a link back to
// /app/dashboard under their slug, rather than the generic "Sign in"
// CTA that (a) is wrong for their state and (b) makes the navigation
// feel like a logout.
//
// Never throws. Any resolution failure (missing cookie, expired
// session, malformed header, DB timeout) degrades to `null`. The
// caller treats null as "render the anonymous header" — no UX break.
//
// Only the `id` and `username` are exposed here. Email / session
// metadata stay server-side; public SSR has no reason to render them
// and surfacing them broadens the XSS blast radius for no benefit.

import { getAuth, type AuthEnv } from "@/server/auth";

export interface PublicSessionUser {
  id: string;
  /**
   * Slug-style username (e.g. `nifty-glacier-783`). Nullable because
   * very early Better Auth-created rows in our DB predate the
   * `username` column; a null value renders as "you" / anonymised
   * affordance rather than a broken `@null` string.
   */
  username: string | null;
}

export async function resolvePublicSession(
  env: AuthEnv,
  request: Request,
): Promise<PublicSessionUser | null> {
  try {
    const auth = getAuth(env);
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return null;
    const user = session.user as { id?: string; username?: string | null };
    if (!user.id) return null;
    return {
      id: user.id,
      username: user.username ?? null,
    };
  } catch {
    // Error-reporting via captureException is tempting here but the
    // public-facing impact of failing-closed is zero: renders as
    // anonymous, same as being signed out. Avoid noise in Sentry for
    // the many benign causes (tests, flaky D1 reads during boot).
    return null;
  }
}
