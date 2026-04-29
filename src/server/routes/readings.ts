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
import { logEvent } from "@/observability/events";
import {
  createReadingSchema,
  createTapReadingSchema,
  formatReadingErrors,
  type ReadingResponse,
} from "@/schemas/reading";
import { getAuth, type AuthEnv } from "@/server/auth";
import { purgeLeaderboardUrls } from "@/server/lib/purge-cache";
import { requireAuth, type RequireAuthVariables } from "@/server/middleware/require-auth";

type Bindings = AuthEnv & {
  DB: D1Database;
  IMAGES: R2Bucket;
  FLAGS: KVNamespace;
  // Analytics Engine (slice #19). Optional because logEvent
  // defaults to a silent no-op when unbound.
  ANALYTICS?: AnalyticsEngineDataset;
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

  // Product telemetry (slice #19). Fire-and-forget.
  await logEvent(
    "reading_submitted",
    { userId: user.id, watchId, is_baseline: input.is_baseline === true },
    c.env,
  );

  return c.json(toResponse(created as DbReadingRow), 201);
});

/**
 * POST /tap — log a manual reading via the "tap the dial position" UX.
 *
 * The client sends only `dial_position` ∈ {0, 15, 30, 45} + an
 * optional `is_baseline` + optional `notes`. The server uses its own
 * `Date.now()` as the reference, which makes the flow spoof-resistant
 * (the client clock is not part of the contract).
 *
 * Deviation math:
 *   refSeconds = floor(now / 1000) % 60
 *   rawDelta   = dial_position - refSeconds        // in [-45, +45]
 *   deviation  = ((rawDelta + 30 + 60) % 60) - 30  // wrap into [-30, +30]
 *
 * Wrapping to [-30, +30] is the natural domain for "which direction
 * is this watch off by" with 15 s granularity. A drift > ±30 s from
 * the nearest minute boundary is ambiguous without the minute hand
 * and is conventionally treated as wrap-around — e.g. tap-0 when the
 * server is at second 45 means the user saw "0" arrive 15 s BEFORE
 * the real minute mark, i.e. the watch is +15 s ahead.
 *
 * `verified` stays 0 — tap readings are still manual, just with the
 * server's clock as the reference rather than the user's typed
 * deviation. Only the in-app camera capture flow yields verified=1.
 */
readingsByWatchRoute.post("/tap", async (c) => {
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
  const parsed = createTapReadingSchema.safeParse(json);
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

  // Reference time is server-authoritative. `Date.now()` under
  // miniflare/workerd honours vi.setSystemTime() in tests.
  const referenceTimestamp = Date.now();
  const refSeconds = Math.floor(referenceTimestamp / 1000) % 60;
  const rawDelta = input.dial_position - refSeconds;
  // ((x % 60) + 60) % 60 gives a non-negative remainder; shifting by
  // +30 before the mod and subtracting after lands us in [-30, +30].
  const wrapped = ((((rawDelta + 30) % 60) + 60) % 60) - 30;
  const deviation = input.is_baseline ? 0 : wrapped;

  const id = crypto.randomUUID();
  await db
    .insertInto("readings")
    .values({
      id,
      watch_id: watchId,
      user_id: user.id,
      reference_timestamp: referenceTimestamp,
      deviation_seconds: deviation,
      is_baseline: input.is_baseline ? 1 : 0,
      notes: input.notes ?? null,
    })
    .execute();

  const created = await db
    .selectFrom("readings")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

  const username = await lookupUsername(db, user.id);
  await purgeLeaderboardUrls({
    requestUrl: new URL(c.req.url),
    movementId: ownership.watch.movement_id,
    username,
    watchId,
  });

  await logEvent(
    "reading_submitted",
    { userId: user.id, watchId, is_baseline: input.is_baseline === true },
    c.env,
  );

  return c.json(toResponse(created as DbReadingRow), 201);
});

/**
 * POST /verified — log a verified (camera-captured, CV-read) reading.
 *
 * **Currently a 503 stub.** The Python dial-reader container that used
 * to back this route was decommissioned in slice #1 of PRD #99 (issue
 * #100). The new VLM-backed Worker-side pipeline lands in slice #4 of
 * PRD #99 (issue #103); until then this route returns the same
 * `error_code: "verified_readings_disabled"` shape the feature-flag
 * gate used to emit, so the SPA's existing `verifiedReadingErrors.ts`
 * mapper renders a friendly "Verified readings aren't enabled for
 * your account yet" alert.
 *
 * The same stub is applied to `/manual_with_photo` (the photo-bearing
 * fallback flow) — both are part of the same dial-reader subsystem
 * being rebuilt.
 */
readingsByWatchRoute.post("/verified", async (c) => {
  const user = c.get("user");
  const watchId = getWatchIdParam(c);
  if (!watchId) return c.json({ error: "not_found" }, 404);

  // Keep emitting the attempt event so funnel analytics survive the
  // rebuild. The decline event below uses the same code the SPA's
  // verifiedReadingErrors.ts mapper already understands, so the UX
  // copy ("Verified readings aren't enabled for your account yet")
  // stays correct without any client changes.
  await logEvent("verified_reading_attempted", { userId: user.id, watchId }, c.env);
  await logEvent(
    "verified_reading_failed",
    { userId: user.id, watchId, error: "verified_readings_disabled" },
    c.env,
  );

  return c.json(
    {
      error_code: "verified_readings_disabled",
      ux_hint:
        "Verified-reading is being rebuilt — please log this reading manually. See PRD #99.",
    },
    503,
  );
});

/**
 * POST /manual_with_photo — fallback flow for slice #80 (PRD #73).
 *
 * **Currently a 503 stub.** Same rebuild as `/verified`: the Python
 * dial-reader container was decommissioned in slice #1 of PRD #99
 * (issue #100). The reference-timestamp + deviation pipeline this
 * route shared with `/verified` is unwired pending slice #4 of PRD
 * #99. Returns the same `verified_readings_disabled` shape so the
 * SPA's existing 503 handling renders cleanly.
 */
readingsByWatchRoute.post("/manual_with_photo", async (c) => {
  const user = c.get("user");
  const watchId = getWatchIdParam(c);
  if (!watchId) return c.json({ error: "not_found" }, 404);

  await logEvent(
    "manual_with_photo_submitted",
    { userId: user.id, watchId, decommissioned: true },
    c.env,
  );

  return c.json(
    {
      error_code: "verified_readings_disabled",
      ux_hint:
        "Verified-reading is being rebuilt — please log this reading manually without a photo. See PRD #99.",
    },
    503,
  );
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
