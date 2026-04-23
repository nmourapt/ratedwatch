// GET /api/v1/me — "who am I" probe used by the SPA's auth gate.
// PATCH /api/v1/me — update the authenticated user's profile
//   (currently just the username; later slices may add display name,
//   avatar, etc.).
//
// Returns `{ id, email, username }` on 200 for an authenticated
// request, or 401 JSON on an unauthenticated one. Session is resolved
// from Better Auth (cookie by default; also works with Authorization:
// Bearer <token> because Better Auth's session lookup honours both).

import { Hono } from "hono";
import { createDb } from "@/db";
import { updateMeSchema, formatUpdateMeErrors } from "@/schemas/user";
import { getAuth, type AuthEnv } from "@/server/auth";
import { requireAuth, type RequireAuthVariables } from "@/server/middleware/require-auth";

type Bindings = AuthEnv & {
  DB: D1Database;
  [key: string]: unknown;
};

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

meRoute.patch("/", async (c) => {
  const user = c.get("user");

  // 1. Parse + validate the body against the shared Zod schema. We
  // return a compact { fieldErrors } shape so the SPA can render
  // each error inline beneath the corresponding input.
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = updateMeSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_input",
        fieldErrors: formatUpdateMeErrors(parsed.error),
      },
      400,
    );
  }
  const { username } = parsed.data;

  // 2. Case-insensitive uniqueness check, excluding the caller. The
  // `user.username` column was created with `COLLATE NOCASE`, so an
  // `=` comparison already matches case-insensitively.
  const db = createDb(c.env);
  const clash = await db
    .selectFrom("user")
    .select("id")
    .where("username", "=", username)
    .where("id", "<>", user.id)
    .executeTakeFirst();
  if (clash) {
    return c.json({ error: "username_taken" }, 409);
  }

  // 3. Update + return the refreshed profile. Keep the caller's
  // preferred casing (we only match case-insensitively).
  const nowIso = new Date().toISOString();
  await db
    .updateTable("user")
    .set({ username, updatedAt: nowIso })
    .where("id", "=", user.id)
    .execute();

  return c.json({
    id: user.id,
    email: user.email,
    username,
  });
});

// Re-export so the worker can mount the route without importing the
// getAuth helper directly (keeps the auth module as a leaf dep of
// the worker entry).
export { getAuth };
