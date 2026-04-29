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
import { cropToDial } from "@/domain/dial-cropper/cropper";
import { createWorkersAiClient } from "@/domain/dial-reader-vlm/ai-client";
import { readDial } from "@/domain/dial-reader-vlm/reader";
import {
  computeSessionStats,
  type Reading,
  type SessionStats,
} from "@/domain/drift-calc";
import {
  DEFAULT_VLM_MODEL,
  verifyVlmReadingFromEnv,
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

type Bindings = AuthEnv & {
  DB: D1Database;
  WATCH_IMAGES: R2Bucket;
  FLAGS: KVNamespace;
  // Workers AI binding — added back in slice #3 of PRD #99 (issue
  // #102) for the new VLM dial reader. The verified-reading route
  // calls into `dial-reader-vlm/reader.ts` which goes
  // `env.AI.run("openai/gpt-5.2", body, { gateway: { id } })`.
  AI: Ai;
  // AI Gateway slug for the VLM call. Defaults to the bake-off
  // gateway in wrangler.jsonc; production gateway lands in slice #9.
  AI_GATEWAY_ID?: string;
  // Cloudflare Images binding for the dial cropper (slice #2 of
  // PRD #99). Used for HEIC decode + 1024-px-long-edge resize +
  // final 768×768 crop.
  IMAGES: ImagesBinding;
  // Analytics Engine (slice #19). Optional because logEvent
  // defaults to a silent no-op when unbound.
  ANALYTICS?: AnalyticsEngineDataset;
  [key: string]: unknown;
};

/**
 * Verified-reading photo size cap. 10 MB is generous for a phone
 * snapshot — the SPA-side `resizePhoto` already shrinks captures to
 * ~1-2 MB, so this is mostly here to deflect a misuse / stuck
 * client rather than a normal-flow constraint.
 */
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
 * POST /verified — log a verified (camera-captured, VLM-read) reading.
 *
 * Slice #4 of PRD #99 (issue #103) wired this route to the new
 * Worker-side hybrid pipeline:
 *
 *   1. Capture `serverArrivalMs` BEFORE the multipart parse so
 *      upload latency does not leak into the reference timestamp.
 *   2. Auth + ownership checks (existing patterns).
 *   3. Parse the multipart body — `image` File + optional
 *      `is_baseline` flag.
 *   4. Call `verifyVlmReadingFromEnv` which crops the photo
 *      (`@/domain/dial-cropper`), reads the dial via a single VLM
 *      call (`@/domain/dial-reader-vlm`), and produces a deviation.
 *   5. INSERT into `readings` with verified=1 and the new
 *      `vlm_model` column (migrations/0008_vlm_dial_reader.sql).
 *   6. Best-effort R2 upload of the photo at
 *      `verified/{userId}/{readingId}.jpg`. A failed upload is
 *      logged but does NOT roll back the reading — the row is the
 *      canonical record, the photo is provenance.
 *
 * Median-of-3 + the anchor-disagreement guard land in slice #5.
 * Rate-limit gating (the `VERIFIED_READING_LIMITER` binding +
 * 50/24h cap) is being re-introduced in a later slice — explicitly
 * out of scope for this tracer bullet per the issue body.
 *
 * Error mapping (matches the SPA's verifiedReadingErrors.ts mapper):
 *   * 400 + error: "image_required"               — no image on form
 *   * 413 + error: "image_too_large"               — > 10 MB
 *   * 422 + error: "exif_clock_skew"               — EXIF outside bounds
 *   * 422 + error_code: "ai_unparseable"           — VLM didn't emit HH:MM:SS
 *   * 502 + error_code: "dial_reader_transport_error" — upstream blew up
 */
readingsByWatchRoute.post("/verified", async (c) => {
  // Capture wall-clock immediately. The multipart parse below can
  // take seconds on cellular; `Date.now()` after the parse would
  // bake that latency into the reference timestamp. See AGENTS.md
  // and the verifier docstring.
  const serverArrivalMs = Date.now();

  const user = c.get("user");
  const watchId = getWatchIdParam(c);
  if (!watchId) return c.json({ error: "not_found" }, 404);

  await logEvent("verified_reading_attempted", { userId: user.id, watchId }, c.env);

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

  const aiGatewayId = c.env.AI_GATEWAY_ID ?? "dial-reader-bakeoff";
  const result = await verifyVlmReadingFromEnv(
    {
      photoBytes: imageBuffer,
      watchId,
      userId: user.id,
      serverArrivalAtMs: serverArrivalMs,
    },
    {
      env: { IMAGES: c.env.IMAGES },
      readDialDeps: {
        ai: createWorkersAiClient(c.env.AI),
        gatewayId: aiGatewayId,
      },
      cropper: cropToDial,
      reader: readDial,
      model: DEFAULT_VLM_MODEL,
    },
  );

  if (!result.ok) {
    await logEvent(
      "verified_reading_failed",
      { userId: user.id, watchId, error: result.error },
      c.env,
    );
    return verifiedReadingErrorResponse(c, result.error, result.raw_response);
  }

  // Success — persist the row. Baseline overrides deviation to 0
  // (matches the existing `is_baseline => deviation_seconds = 0`
  // contract from the manual flow).
  const deviation = isBaseline ? 0 : result.deviation_seconds;
  const id = crypto.randomUUID();
  await db
    .insertInto("readings")
    .values({
      id,
      watch_id: watchId,
      user_id: user.id,
      reference_timestamp: result.reference_timestamp_ms,
      deviation_seconds: deviation,
      is_baseline: isBaseline ? 1 : 0,
      verified: 1,
      notes: null,
      vlm_model: result.vlm_model,
    })
    .execute();

  // Best-effort R2 upload. Failure does NOT roll back — the DB row
  // is the canonical record. Permanent prefix `verified/{userId}/{id}.jpg`
  // — slice #6 will introduce the draft/confirm split where photos
  // live under a draft prefix until confirmed.
  const photoKey = `verified/${user.id}/${id}.jpg`;
  let storedPhotoKey: string | null = null;
  try {
    await c.env.WATCH_IMAGES.put(photoKey, imageBuffer, {
      httpMetadata: { contentType: image.type || "image/jpeg" },
    });
    storedPhotoKey = photoKey;
    await db
      .updateTable("readings")
      .set({ photo_r2_key: photoKey })
      .where("id", "=", id)
      .execute();
  } catch (err) {
    console.warn(
      `verified-reading: R2 upload failed for reading ${id}, continuing:`,
      err,
    );
  }
  void storedPhotoKey; // tracked for symmetry; not surfaced on the response

  const created = (await db
    .selectFrom("readings")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow()) as DbReadingRow;

  // Fire-and-forget cache purge — same scope as the manual POST.
  const username = await lookupUsername(db, user.id);
  await purgeLeaderboardUrls({
    requestUrl: new URL(c.req.url),
    movementId: ownership.watch.movement_id,
    username,
    watchId,
  });

  await logEvent(
    "verified_reading_succeeded",
    { userId: user.id, watchId, is_baseline: isBaseline },
    c.env,
  );

  return c.json(toResponse(created), 201);
});

/**
 * Map a verifier error code to the wire-format error response.
 * Mirrors the wording/shape the SPA's
 * `verifiedReadingErrors.ts::mapVerifiedReadingError` already
 * understands — see the comments there for the matrix. We do NOT
 * leak `raw_response` for the AI errors (it can include the full
 * model output, which is excessive for the SPA) but we keep it on
 * the EXIF-skew branch where the legacy shape carries a debug hint.
 *
 * Slice #5 of PRD #99 (issue #104) added the median-of-3 + anchor
 * guard error codes:
 *   * `dial_reader_anchor_disagreement` — median MM:SS diverges
 *     > 60 s from the EXIF anchor. 422; user retakes.
 *   * `dial_reader_anchor_echo_flagged` — all 3 reads echoed the
 *     anchor (suspicious cheat pattern). 422; copy says
 *     "inconclusive read, please retake" — we deliberately don't
 *     surface "we caught you cheating".
 *   * `ai_refused` — all 3 reads were unparseable (model fully
 *     refused). 422; same retake UX.
 */
function verifiedReadingErrorResponse(
  c: {
    json: (body: unknown, status: number) => Response;
  },
  code: VerifyReadingErrorCode,
  rawResponse: string | undefined,
): Response {
  if (code === "exif_clock_skew") {
    return c.json({ error: code, raw_response: rawResponse }, 422);
  }
  if (code === "dial_reader_transport_error") {
    return c.json(
      {
        error_code: code,
        ux_hint: "Connection failed while reading dial. Please try again.",
      },
      502,
    );
  }
  if (code === "dial_reader_anchor_disagreement") {
    return c.json(
      {
        error_code: code,
        ux_hint:
          "We couldn't reconcile the dial with your phone's clock. Please retake the photo.",
      },
      422,
    );
  }
  if (code === "dial_reader_anchor_echo_flagged") {
    return c.json(
      {
        error_code: code,
        ux_hint: "Inconclusive read — please retake the photo.",
      },
      422,
    );
  }
  if (code === "ai_refused") {
    return c.json(
      {
        error_code: code,
        ux_hint:
          "We couldn't read the dial in your photo — try a clearer shot or log manually.",
      },
      422,
    );
  }
  // ai_unparseable
  return c.json(
    {
      error_code: code,
      ux_hint:
        "We couldn't read the dial in your photo — try a clearer shot or log manually.",
    },
    422,
  );
}

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
