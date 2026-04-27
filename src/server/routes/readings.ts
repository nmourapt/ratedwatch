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
import { maybeIngest } from "@/domain/corpus";
import type { DialReaderEnv } from "@/domain/dial-reader";
import {
  computeSessionStats,
  type Reading,
  type SessionStats,
} from "@/domain/drift-calc";
import { isEnabled } from "@/domain/feature-flags";
import {
  verifyReading,
  type VerifyReadingErrorCode,
} from "@/domain/reading-verifier/verifier";
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

type Bindings = AuthEnv &
  DialReaderEnv & {
    DB: D1Database;
    AI: Ai;
    IMAGES: R2Bucket;
    // Slice #81 (PRD #73): training-corpus bucket. The
    // verified-reading route writes here via
    // `corpus.maybeIngest`. Optional in the type so legacy tests
    // / callers without the binding still compile; production
    // wrangler.jsonc always has it.
    R2_CORPUS?: R2Bucket;
    FLAGS: KVNamespace;
    // Analytics Engine (slice #19). Optional because logEvent
    // defaults to a silent no-op when unbound.
    ANALYTICS?: AnalyticsEngineDataset;
    [key: string]: unknown;
  };

// Feature flag gating the verified-reading endpoint. Default-off in
// prod; the operator enables it per-user via `npm run flags:set`.
const FLAG_AI_READING_V2 = "ai_reading_v2";
// 10 MB cap on the uploaded image. Workers already enforce a body-size
// limit but the cap here is the product contract — anything larger
// gets a clean 413 rather than a generic workerd abort.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

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
 * POST /verified — log a verified (camera-captured, AI-read) reading.
 *
 * Multipart body:
 *   * `image` (file, required, max 10 MB, image/jpeg)
 *   * `is_baseline` (string "true"/"false", optional, default false)
 *
 * Backend selection:
 *   * `ai_reading_v2` flag ON  → CV dial-reader container (slice
 *     #75 of PRD #73). Returns the new `dial_reader_*` error
 *     vocabulary on rejection.
 *   * `ai_reading_v2` flag OFF → legacy Workers AI runner.
 *     Preserved as a fallback path for the duration of the slice
 *     window; deleted in slice #11 once CV has proven itself.
 *
 * On success: 201 with the inserted reading.
 * On rejection: 422 with `{ error_code, ux_hint }` (CV path) or
 *   the legacy `{ error, raw_response }` shape (AI path) — the SPA
 *   already knows the AI shape and slice #80 will switch it to the
 *   structured CV shape once user-facing UX work lands.
 * On a transport-layer failure to the CV container: 502 (the
 *   container ran but did not return a CV decision; retryable).
 */
readingsByWatchRoute.post("/verified", async (c) => {
  // Capture the wall-clock at handler entry, BEFORE any await. This
  // is the fallback reference timestamp the verifier uses when EXIF
  // is missing and the bounds anchor when EXIF is present. Capturing
  // here — rather than inside `verifyReading` after `formData()` has
  // resolved — sidesteps the upload-latency phantom drift that
  // motivated this slice: a 2 MB photo on cellular bakes 2-8 s of
  // body-parse delay into a `Date.now()` placed any later in the
  // handler.
  const serverArrivalMs = Date.now();

  const user = c.get("user");
  const watchId = getWatchIdParam(c);
  if (!watchId) return c.json({ error: "not_found" }, 404);

  // Event: attempt counter. Fires regardless of flag state / outcome
  // so funnel analysis can see how many users are bouncing off the
  // feature-flagged gate vs the AI step.
  await logEvent("verified_reading_attempted", { userId: user.id, watchId }, c.env);

  // Feature flag gate decides which backend handles this read. The
  // service default-offs on any error (missing FLAGS binding,
  // malformed KV value, …) so a freshly-provisioned environment
  // sees the legacy AI path, never the CV path.
  const useDialReader = await isEnabled(FLAG_AI_READING_V2, { userId: user.id }, c.env);

  const db = createDb(c.env);
  const ownership = await assertWatchOwnership(db, watchId, user.id);
  if (ownership.status === "not_found") {
    return c.json({ error: "not_found" }, 404);
  }
  if (ownership.status === "forbidden") {
    return c.json({ error: "forbidden" }, 403);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "invalid_multipart" }, 400);
  }

  const image = form.get("image");
  if (!(image instanceof File) || image.size === 0) {
    return c.json({ error: "image_required" }, 400);
  }
  if (image.size > MAX_IMAGE_BYTES) {
    return c.json({ error: "image_too_large", max_bytes: MAX_IMAGE_BYTES }, 413);
  }

  const isBaselineRaw = form.get("is_baseline");
  const isBaseline =
    typeof isBaselineRaw === "string" && isBaselineRaw.toLowerCase() === "true";

  const imageBuffer = await image.arrayBuffer();
  const imageContentType =
    image.type && image.type.length > 0 ? image.type : "image/jpeg";

  const result = await verifyReading({
    watchId,
    userId: user.id,
    imageBuffer,
    isBaseline,
    serverArrivalMs,
    useDialReader,
    env: c.env,
  });

  // Slice #81 (PRD #73): corpus collection. Look up the caller's
  // `consent_corpus` flag once and queue a fire-and-forget ingest
  // attempt that runs only when the gate (consent + low-margin
  // confidence OR rejection) is satisfied. Wrapping the entire
  // sub-pipeline in `waitUntil` so neither the DB lookup nor the
  // R2 writes block the user-facing response. The gate logic
  // itself lives in `corpus.maybeIngest` — this layer only feeds
  // the right inputs in.
  if (c.env.R2_CORPUS) {
    const corpusEnv = { R2_CORPUS: c.env.R2_CORPUS };
    const photoBytes = new Uint8Array(imageBuffer);
    const verified = result.ok ? result.reading.verified : false;
    const confidence = result.ok
      ? result.reading.dial_reader_confidence
      : (result.dial_reader_confidence ?? null);
    const dialReaderVersion = result.ok
      ? result.reading.dial_reader_version
      : (result.dial_reader_version ?? null);
    const rejectionReason = result.ok ? null : result.error;
    const readingId = result.ok ? result.reading.id : crypto.randomUUID();

    const work = (async () => {
      try {
        const db = createDb(c.env);
        const userRow = await db
          .selectFrom("user")
          .select("consent_corpus")
          .where("id", "=", user.id)
          .executeTakeFirst();
        const consentCorpus = (userRow?.consent_corpus ?? 0) === 1;
        await maybeIngest({
          readingId,
          photoBytes,
          imageContentType,
          consentCorpus,
          verified,
          confidence,
          rejectionReason,
          dialReaderVersion,
          env: corpusEnv,
        });
      } catch (err) {
        // Swallow — corpus collection is opportunistic and must
        // never affect the user-facing response. Logged so an
        // operator tail can spot systemic failures.
        console.warn("verified-reading: corpus ingest queue failed:", err);
      }
    })();
    c.executionCtx.waitUntil(work);
  }

  if (!result.ok) {
    await logEvent(
      "verified_reading_failed",
      { userId: user.id, watchId, error: result.error },
      c.env,
    );
    return errorResponse(c, result.error, result.raw_response);
  }

  // Map the verifier's row shape into the existing wire format.
  const body: ReadingResponse = {
    id: result.reading.id,
    watch_id: result.reading.watch_id,
    user_id: result.reading.user_id,
    reference_timestamp: result.reading.reference_timestamp,
    deviation_seconds: result.reading.deviation_seconds,
    is_baseline: result.reading.is_baseline,
    verified: result.reading.verified,
    notes: result.reading.notes,
    created_at: result.reading.created_at,
  };
  await logEvent(
    "verified_reading_succeeded",
    { userId: user.id, watchId, is_baseline: result.reading.is_baseline },
    c.env,
  );
  return c.json(body, 201);
});

// ---- Error-code → HTTP response mapping ---------------------------
//
// PRD #73 User Stories #7-#11 spell out the SPA-facing UX for each
// rejection class. Keeping the wording in one place here means the
// SPA (slice #80) can switch on the `error_code` without ever
// having to read the human-facing string — but the string IS the
// fallback for any client that hasn't shipped the dedicated UX yet.
//
// Hint copy is intentionally short and action-oriented. Verbatim
// from the PRD where possible so QA can grep the SPA / API for
// drift in a single PR review.
//
// HTTP status choices:
//   * 422 for any "your photo can't be processed" rejection — the
//     request was well-formed, the verifier had a chance to look
//     at it, but the content fails business validation. This is
//     the same 422 the AI path uses today.
//   * 502 for `dial_reader_transport_error` — the container did
//     not have a chance to make a CV decision (5xx, network) so
//     retrying might succeed. 502 is the conventional "upstream
//     gave up" signal.
const DIAL_READER_UX_HINTS: Record<string, string> = {
  dial_reader_unsupported_dial:
    "this watch type isn't supported by verified-reading yet — please log manually",
  dial_reader_low_confidence:
    "we couldn't read this dial confidently — please try a sharper photo, or log manually",
  dial_reader_no_dial_found:
    "we couldn't find a watch dial in this photo. Make sure the dial is centered and well-lit",
  dial_reader_malformed_image:
    "we couldn't decode this image. Please try again with a JPEG, PNG, WebP, or HEIC photo",
  dial_reader_transport_error:
    "the dial reader is temporarily unavailable. Please try again in a moment",
};

function errorResponse(
  c: {
    json: (body: unknown, status: number) => Response;
  },
  code: VerifyReadingErrorCode,
  rawResponse: string | undefined,
): Response {
  // Legacy AI-path errors keep their existing wire shape so the
  // SPA's current handling stays valid until slice #80 unifies the
  // shape. The CV-path errors use the new `error_code` + `ux_hint`
  // structure spec'd in the slice #75 issue body.
  if (code === "ai_refused" || code === "ai_unparseable" || code === "ai_implausible") {
    return c.json({ error: code, raw_response: rawResponse }, 422);
  }
  if (code === "exif_clock_skew") {
    return c.json({ error: code, raw_response: rawResponse }, 422);
  }
  const hint = DIAL_READER_UX_HINTS[code] ?? "verified reading rejected";
  const status = code === "dial_reader_transport_error" ? 502 : 422;
  return c.json({ error_code: code, ux_hint: hint }, status);
}

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
