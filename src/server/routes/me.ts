// GET /api/v1/me — "who am I" probe used by the SPA's auth gate.
// PATCH /api/v1/me — update the authenticated user's profile
//   (currently username and consent_corpus; later slices may add
//   display name, avatar, etc.).
//
// Returns `{ id, email, username }` on 200 for an authenticated
// request, or 401 JSON on an unauthenticated one. Session is resolved
// from Better Auth (cookie by default; also works with Authorization:
// Bearer <token> because Better Auth's session lookup honours both).
//
// Slice #81 (PRD #73): the consent_corpus toggle is honoured here.
// When a user transitions consent_corpus from 1 to 0, we kick off
// a best-effort retroactive deletion of every corpus object derived
// from any of the user's readings — wrapping it in waitUntil so the
// HTTP response is unaffected.

import { Hono } from "hono";
import { createDb } from "@/db";
import { deleteUserCorpusObjects } from "@/domain/corpus";
import { updateMeSchema, formatUpdateMeErrors } from "@/schemas/user";
import { getAuth, type AuthEnv } from "@/server/auth";
import { requireAuth, type RequireAuthVariables } from "@/server/middleware/require-auth";

type Bindings = AuthEnv & {
  DB: D1Database;
  // Slice #81: training-corpus bucket. Optional in the type so
  // legacy / minimally-bound test environments still compile;
  // production wrangler.jsonc always has it.
  R2_CORPUS?: R2Bucket;
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
  const { username, consent_corpus } = parsed.data;
  const db = createDb(c.env);

  // 2. Username branch: case-insensitive uniqueness check, excluding
  // the caller. The `user.username` column was created with `COLLATE
  // NOCASE`, so an `=` comparison already matches case-insensitively.
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

  // 3. consent_corpus branch: detect a 1→0 transition BEFORE the
  // UPDATE so we can hand the right action to the retroactive-
  // deletion helper. We read the current value from D1 (rather
  // than trusting the Better Auth user object on `c.get("user")`,
  // which may carry a stale snapshot if the value was changed
  // since the session started).
  let priorConsent: number | null = null;
  if (consent_corpus !== undefined) {
    const row = await db
      .selectFrom("user")
      .select("consent_corpus")
      .where("id", "=", user.id)
      .executeTakeFirst();
    priorConsent = row?.consent_corpus ?? 0;
  }

  // 4. Apply the update. Build the SET clause dynamically so a
  // username-only or consent-only PATCH doesn't accidentally clobber
  // the other column. Always bump `updatedAt` so the auth layer
  // picks up the change.
  const nowIso = new Date().toISOString();
  const updates: { username?: string; consent_corpus?: number; updatedAt: string } = {
    updatedAt: nowIso,
  };
  if (username !== undefined) updates.username = username;
  if (consent_corpus !== undefined) {
    updates.consent_corpus = consent_corpus ? 1 : 0;
  }
  await db.updateTable("user").set(updates).where("id", "=", user.id).execute();

  // 5. Retroactive corpus cleanup on a 1→0 transition. Fire-and-
  // forget — the response below should not wait on the (potentially
  // many-page) R2 list+delete walk. The helper is best-effort and
  // never throws.
  if (consent_corpus === false && priorConsent === 1 && c.env.R2_CORPUS !== undefined) {
    const corpusEnv = { R2_CORPUS: c.env.R2_CORPUS };
    c.executionCtx.waitUntil(
      deleteUserCorpusObjects({ userId: user.id, db, env: corpusEnv }),
    );
  }

  // 6. Refresh + return. We re-read the username from the DB so the
  // response always reflects the persisted value (covers a
  // consent-only PATCH where the body didn't include a username).
  const fresh = await db
    .selectFrom("user")
    .select(["username", "consent_corpus"])
    .where("id", "=", user.id)
    .executeTakeFirst();

  return c.json({
    id: user.id,
    email: user.email,
    username: fresh?.username ?? username ?? null,
    consent_corpus: (fresh?.consent_corpus ?? 0) === 1,
  });
});

// Re-export so the worker can mount the route without importing the
// getAuth helper directly (keeps the auth module as a leaf dep of
// the worker entry).
export { getAuth };
