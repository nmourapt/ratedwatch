// Readings CRUD. Two Hono sub-apps exported from this module:
//
//   * `readingsByWatchRoute` — mounted at /api/v1/watches/:watchId/readings
//     Handles POST (log) and GET (list + session stats). Anonymous
//     GET is allowed when the parent watch is_public, matching the
//     pattern already set by src/server/routes/watches.ts.
//
//   * `readingsByIdRoute` — mounted at /api/v1/readings
//     Handles DELETE /:id. Ownership is resolved via a join back to
//     the owning watch.
//
// Shape conventions mirror watches.ts:
//   * 400 `{ error: "invalid_input", fieldErrors }` on Zod failure.
//   * 401 `{ error: "unauthorized" }` from requireAuth.
//   * 403 `{ error: "forbidden" }` when the caller isn't the owner.
//   * 404 `{ error: "not_found" }` for unknown id / private watch
//     accessed by anon / non-owner (we don't leak existence).
//
// The `is_baseline ⇒ deviation_seconds = 0` rule (AGENTS.md: "the
// watch just set to the exact time; deviation is 0") is enforced here
// so a stale client can't corrupt the math by sending a non-zero
// deviation with the baseline flag.

import { Hono } from "hono";
import { createDb } from "@/db";
import type { DB } from "@/db";
import {
  computeSessionStats,
  type Reading,
  type SessionStats,
} from "@/domain/drift-calc";
import { assertWatchOwnership } from "@/domain/watches/ownership";
import {
  createReadingSchema,
  formatReadingErrors,
  type ReadingResponse,
} from "@/schemas/reading";
import { getAuth, type AuthEnv } from "@/server/auth";
import { purgeLeaderboardUrls } from "@/server/lib/purge-cache";
import { requireAuth, type RequireAuthVariables } from "@/server/middleware/require-auth";

type Bindings = AuthEnv & {
  DB: D1Database;
  [key: string]: unknown;
};

// ---- Shared mappers ------------------------------------------------

interface DbReadingRow {
  id: string;
  watch_id: string;
  user_id: string;
  reference_timestamp: number;
  deviation_seconds: number;
  is_baseline: number;
  verified: number;
  notes: string | null;
  created_at: string;
}

function toResponse(row: DbReadingRow): ReadingResponse {
  return {
    id: row.id,
    watch_id: row.watch_id,
    user_id: row.user_id,
    reference_timestamp: row.reference_timestamp,
    deviation_seconds: row.deviation_seconds,
    is_baseline: row.is_baseline === 1,
    verified: row.verified === 1,
    notes: row.notes,
    created_at: row.created_at,
  };
}

function toDomain(row: DbReadingRow): Reading {
  return {
    id: row.id,
    reference_timestamp: row.reference_timestamp,
    deviation_seconds: row.deviation_seconds,
    is_baseline: row.is_baseline === 1,
    verified: row.verified === 1,
  };
}

async function listReadingsForWatch(db: DB, watchId: string): Promise<DbReadingRow[]> {
  const rows = await db
    .selectFrom("readings")
    .selectAll()
    .where("watch_id", "=", watchId)
    .orderBy("reference_timestamp", "asc")
    .execute();
  return rows as DbReadingRow[];
}

/**
 * Fetch the owner's username for a user_id. Best-effort — returns null
 * if the user was deleted mid-request (shouldn't happen, but we guard
 * so the cache purge never throws). Only used by the purge helper.
 */
async function lookupUsername(db: DB, userId: string): Promise<string | null> {
  const row = await db
    .selectFrom("user")
    .select(["username"])
    .where("id", "=", userId)
    .executeTakeFirst();
  return row?.username ?? null;
}

// ---- /api/v1/watches/:watchId/readings ----------------------------

export const readingsByWatchRoute = new Hono<{
  Bindings: Bindings;
  Variables: RequireAuthVariables;
}>();

// Hono can't infer outer-mount params in a sub-app's type system, so
// we read them as unknown and narrow with a runtime guard. The mount
// path in src/worker/index.tsx guarantees :watchId is present at
// request time, but the compiler doesn't know that.
function getWatchIdParam(c: {
  req: { param: (name: string) => string | undefined };
}): string | null {
  const raw = c.req.param("watchId");
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * GET — list readings + session stats.
 *
 * Public-watch rule: anonymous callers can read when the parent
 * watch's `is_public` is true. Otherwise we return 404 so the route
 * doesn't leak existence of private watches.
 *
 * Registered BEFORE the blanket requireAuth middleware so anon
 * callers can hit it without a 401.
 */
readingsByWatchRoute.get("/", async (c) => {
  const watchId = getWatchIdParam(c);
  if (!watchId) return c.json({ error: "not_found" }, 404);
  const db = createDb(c.env);

  const auth = getAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const callerId = (session?.user as { id: string } | undefined)?.id ?? null;

  const watch = await db
    .selectFrom("watches")
    .select(["id", "user_id", "is_public"])
    .where("id", "=", watchId)
    .executeTakeFirst();
  if (!watch) {
    return c.json({ error: "not_found" }, 404);
  }
  const isOwner = callerId !== null && watch.user_id === callerId;
  const isPublic = watch.is_public === 1;
  if (!isPublic && !isOwner) {
    return c.json({ error: "not_found" }, 404);
  }

  const rows = await listReadingsForWatch(db, watchId);
  const readings = rows.map(toResponse);
  const session_stats: SessionStats | null =
    rows.length === 0 ? null : computeSessionStats(rows.map(toDomain));

  return c.json({ readings, session_stats });
});

// Mutating routes below require a session.
readingsByWatchRoute.use("*", requireAuth);

/**
 * POST — log a manual reading against an owned watch.
 *
 * Baseline rule: when `is_baseline=true`, `deviation_seconds` is
 * forced to 0 server-side no matter what the client sent. Rejecting
 * a stale client outright would be user-hostile — correcting the
 * value is the safer, lower-surprise behaviour.
 */
readingsByWatchRoute.post("/", async (c) => {
  const user = c.get("user");
  const watchId = getWatchIdParam(c);
  if (!watchId) return c.json({ error: "not_found" }, 404);
  const db = createDb(c.env);

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = createReadingSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { error: "invalid_input", fieldErrors: formatReadingErrors(parsed.error) },
      400,
    );
  }
  const input = parsed.data;

  const ownership = await assertWatchOwnership(db, watchId, user.id);
  if (ownership.status === "not_found") {
    return c.json({ error: "not_found" }, 404);
  }
  if (ownership.status === "forbidden") {
    return c.json({ error: "forbidden" }, 403);
  }

  // Baseline readings are, by definition, "watch just set to true
  // time" — deviation is 0. See AGENTS.md glossary.
  const deviation = input.is_baseline ? 0 : input.deviation_seconds;

  const id = crypto.randomUUID();
  await db
    .insertInto("readings")
    .values({
      id,
      watch_id: watchId,
      user_id: user.id,
      reference_timestamp: input.reference_timestamp,
      deviation_seconds: deviation,
      is_baseline: input.is_baseline ? 1 : 0,
      // verified stays at default 0 — slice #16 flips it via the
      // in-app camera capture flow.
      notes: input.notes ?? null,
    })
    .execute();

  const created = await db
    .selectFrom("readings")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

  // Cache purge: public leaderboard + home hero + per-movement / per-user /
  // per-watch pages all depend on reading state. Best-effort — if the
  // purge fails the s-maxage=300 TTL is the fallback.
  const username = await lookupUsername(db, user.id);
  await purgeLeaderboardUrls({
    requestUrl: new URL(c.req.url),
    movementId: ownership.watch.movement_id,
    username,
    watchId,
  });

  return c.json(toResponse(created as DbReadingRow), 201);
});

// ---- /api/v1/readings/:id -----------------------------------------

export const readingsByIdRoute = new Hono<{
  Bindings: Bindings;
  Variables: RequireAuthVariables;
}>();

readingsByIdRoute.use("*", requireAuth);

/**
 * DELETE /api/v1/readings/:id — destroy a reading you own.
 *
 * We resolve ownership via the parent watch: a reading is "owned" by
 * the same user that owns its watch. The `user_id` column on readings
 * is denormalised for per-user queries but we still cross-check via
 * the watches table so an inconsistent denorm (should never happen,
 * but defensive programming) doesn't let someone bypass the check.
 */
readingsByIdRoute.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!id) return c.json({ error: "not_found" }, 404);
  const db = createDb(c.env);

  const row = await db
    .selectFrom("readings")
    .select(["id", "watch_id"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) {
    return c.json({ error: "not_found" }, 404);
  }

  const ownership = await assertWatchOwnership(db, row.watch_id, user.id);
  if (ownership.status === "not_found") {
    // The parent watch vanished (should be impossible with FK cascade,
    // but if it happens we surface 404 rather than crash).
    return c.json({ error: "not_found" }, 404);
  }
  if (ownership.status === "forbidden") {
    return c.json({ error: "forbidden" }, 403);
  }

  await db.deleteFrom("readings").where("id", "=", id).execute();

  // Mirror the POST purge — any mutation to the watch's readings
  // invalidates the same cached URL set.
  const username = await lookupUsername(db, user.id);
  await purgeLeaderboardUrls({
    requestUrl: new URL(c.req.url),
    movementId: ownership.watch.movement_id,
    username,
    watchId: row.watch_id,
  });

  return c.body(null, 204);
});
