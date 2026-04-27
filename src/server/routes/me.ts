// GET /api/v1/me — "who am I" probe used by the SPA's auth gate.
// PATCH /api/v1/me — update the authenticated user's profile.
//
// PATCH currently accepts:
//   * `username` — the SPA's settings rename flow (slice #14).
//   * `consent_corpus` (boolean) — slice #80 of PRD #73, the
//     opt-in toggle that lets the operator copy a user's
//     rejected/low-confidence photos into the training corpus.
//     Default off, unset means "no change". Per PRD User Stories
//     #13-#16, it's privacy-preserving by default.
//
// Both fields are optional; the schema accepts either alone, both,
// or neither (the empty-object case is rejected with `no_changes`
// to surface client bugs early). Each present field is updated
// independently — the route never clobbers an unset field.
//
// Returns `{ id, email, username, consent_corpus }` on 200 for an
// authenticated request, or 401 JSON on an unauthenticated one.
// Session is resolved from Better Auth (cookie by default; also
// works with Authorization: Bearer <token> because Better Auth's
// session lookup honours both).

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

/**
 * Fetch the user's full row including the consent_corpus column,
 * which Better Auth doesn't expose via its session-cached user
 * object. A single small select per /me hit is fine — the route is
 * only called on auth-gate refreshes and the settings page.
 */
async function fetchUserExtras(
  db: ReturnType<typeof createDb>,
  userId: string,
): Promise<{ consent_corpus: number } | null> {
  const row = await db
    .selectFrom("user")
    .select(["consent_corpus"])
    .where("id", "=", userId)
    .executeTakeFirst();
  return (row as { consent_corpus: number } | undefined) ?? null;
}

meRoute.get("/", async (c) => {
  const user = c.get("user");
  const db = createDb(c.env);
  const extras = await fetchUserExtras(db, user.id);
  // Better Auth's additionalFields appear on the user object at
  // runtime. Type them narrowly for the JSON payload we expose to
  // the SPA; the full user may carry more fields we don't want to
  // leak (timestamps, email verification flag, etc.) in a later slice.
  const payload = {
    id: user.id,
    email: user.email,
    username: (user as { username?: string }).username ?? null,
    consent_corpus: extras ? extras.consent_corpus === 1 : false,
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
  const { username, consent_corpus } = parsed.data;

  // Empty-object PATCH is a client bug — surface it as invalid_input
  // rather than a silent 200 with no changes.
  if (username === undefined && consent_corpus === undefined) {
    return c.json(
      {
        error: "invalid_input",
        fieldErrors: { _: "At least one of username, consent_corpus is required" },
      },
      400,
    );
  }

  const db = createDb(c.env);

  // 2. Username uniqueness check (only if a username change is in
  //    play). The `user.username` column was created with
  //    `COLLATE NOCASE`, so an `=` comparison already matches
  //    case-insensitively.
  if (username !== undefined) {
    const clash = await db
      .selectFrom("user")
      .select("id")
      .where("username", "=", username)
      .where("id", "<>", user.id)
      .executeTakeFirst();
    if (clash) {
      return c.json({ error: "username_taken" }, 409);
    }
  }

  // 3. Update only the fields the caller actually sent. Kysely's
  //    `.set()` accepts a partial object, so building it
  //    conditionally keeps the SQL UPDATE minimal and avoids
  //    clobbering unset columns.
  const nowIso = new Date().toISOString();
  const updates: { username?: string; consent_corpus?: number; updatedAt: string } = {
    updatedAt: nowIso,
  };
  if (username !== undefined) {
    updates.username = username;
  }
  if (consent_corpus !== undefined) {
    // SQLite booleans are 0/1 INTEGER (see migration 0007).
    updates.consent_corpus = consent_corpus ? 1 : 0;
  }
  await db.updateTable("user").set(updates).where("id", "=", user.id).execute();

  // 4. Return the refreshed full profile. Read consent_corpus back
  //    from the DB rather than echoing the input so the response is
  //    always the canonical persisted value.
  const refreshed = await fetchUserExtras(db, user.id);
  return c.json({
    id: user.id,
    email: user.email,
    username: username ?? (user as { username?: string }).username ?? null,
    consent_corpus: refreshed ? refreshed.consent_corpus === 1 : false,
  });
});

// Re-export so the worker can mount the route without importing the
// getAuth helper directly (keeps the auth module as a leaf dep of
// the worker entry).
export { getAuth };
