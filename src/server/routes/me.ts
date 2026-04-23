// GET /api/v1/me — "who am I" probe used by the SPA's auth gate.
//
// Returns `{ id, email, username }` on 200 for an authenticated
// request, or 401 JSON on an unauthenticated one. Session is resolved
// from Better Auth (cookie by default; also works with Authorization:
// Bearer <token> because Better Auth's session lookup honours both).

import { Hono } from "hono";
import { getAuth, type AuthEnv } from "@/server/auth";
import { requireAuth, type RequireAuthVariables } from "@/server/middleware/require-auth";

type Bindings = AuthEnv & { [key: string]: unknown };

export const meRoute = new Hono<{
  Bindings: Bindings;
  Variables: RequireAuthVariables;
}>();

meRoute.use("*", requireAuth);

meRoute.get("/", (c) => {
  const user = c.get("user");
  // Better Auth's additionalFields appear on the user object at
  // runtime. Type them narrowly for the JSON payload we expose to
  // the SPA; the full user may carry more fields we don't want to
  // leak (timestamps, email verification flag, etc.) in a later slice.
  const payload = {
    id: user.id,
    email: user.email,
    username: (user as { username?: string }).username ?? null,
  };
  return c.json(payload);
});

// Re-export so the worker can mount the route without importing the
// getAuth helper directly (keeps the auth module as a leaf dep of
// the worker entry).
export { getAuth };
