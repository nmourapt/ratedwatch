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
import { z } from "zod";
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
import {
  READING_TOKEN_TTL_SECONDS,
  signReadingToken,
  verifyReadingToken,
  type ReadingTokenPayload,
} from "@/domain/reading-token/token";
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
  // HMAC-SHA256 secret used to sign the `reading_token` envelope
  // exchanged between /readings/verified/draft and
  // /readings/verified/confirm (slice #6 of PRD #99). Set via
  // `wrangler secret put READING_TOKEN_SECRET` in production; the
  // miniflare test config seeds a deterministic value via bindings.
  // 32+ bytes of entropy required (`openssl rand -base64 32`).
  READING_TOKEN_SECRET: string;
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

// ---- Verified-reading two-step API (slice #6 of PRD #99) ----------
//
// The synchronous `POST /verified` route is replaced by:
//
//   1. POST /verified/draft   — accepts the photo, runs the VLM
//      pipeline, persists the photo to a temporary R2 prefix
//      (`drafts/{user_id}/{uuid}.jpg`), and returns a signed
//      `reading_token` + the predicted HH:MM:SS (12-hour) + a
//      photo URL. Does NOT save a reading row.
//
//   2. POST /verified/confirm — accepts `{ reading_token,
//      final_hms }`. Verifies the token signature and expiry,
//      cross-checks the payload's user_id/watch_id against the
//      session and request, validates `final_hms` shape (h ∈
//      [1, 12], m/s ∈ [0, 59]), saves the reading row, and
//      moves the photo from `drafts/` to
//      `verified/{user_id}/{reading_id}.jpg`. PR #122 removed
//      the previous ±30s adjustment cap.
//
// Anti-cheat property: `/draft` returns the prediction but NOT
// the deviation. The SPA confirmation page (slice #7) lets the
// user adjust ± seconds without ever seeing the deviation, so a
// user can't naively dial up to "make their watch look perfect".
//
// `READING_TOKEN_SECRET` carries the integrity guarantee. A
// missing or wrong secret on the server makes every confirm a 401;
// the route layer never falls back to "trust the client".
//
// Photo lifecycle:
//   * On `/draft` success: photo lives at `drafts/{user_id}/{uuid}.jpg`.
//   * R2 lifecycle rule expires `drafts/` after 24h (handled in
//     `infra/terraform/r2.tf`), so abandoned drafts don't pile up.
//   * On `/confirm` success: photo is copied to
//     `verified/{user_id}/{reading_id}.jpg` and the draft copy
//     deleted. The copy+delete sequence is idempotent — if the
//     verified copy already exists, the second attempt is a no-op
//     re-write of the same bytes.

/**
 * Confirm body schema. PR #122 reworked the adjustment surface from
 * seconds-only ±30s to per-component HH:MM:SS up/down. The server
 * accepts any well-shaped 12-hour HH:MM:SS triple — there's no
 * adjustment cap. The defenses against malicious clients are:
 *
 *   * The reading-token's HMAC signature + 5-min expiry.
 *   * The photo stored in R2 (audit trail).
 *   * The watch-ownership + auth + rate-limit checks earlier in
 *     the handler.
 *
 * The previous ±30s cap was always more about UI nudge than fraud
 * prevention — a determined cheater knows the rough current time
 * from their phone clock and can game the value either way. The
 * photo audit is the real check.
 */
const confirmReadingSchema = z.object({
  reading_token: z.string().min(1),
  final_hms: z.object({
    h: z.number().int().min(1).max(12),
    m: z.number().int().min(0).max(59),
    s: z.number().int().min(0).max(59),
  }),
  is_baseline: z.boolean().optional(),
});

/**
 * Format a unix-ms timestamp as `HH:MM:SS` UTC for the
 * `anchor_hms` field of the reading-token payload. We don't bake a
 * full unix timestamp into the token because the deviation calc on
 * confirm only needs the MM:SS components — but we keep the hour
 * for log/debug purposes (anchor-vs-prediction mismatch
 * investigation).
 */
function formatHms(timestampMs: number): string {
  const d = new Date(timestampMs);
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/**
 * Convert a 12-hour HH:MM:SS triple to total seconds on the
 * [0, 43200) 12-hour cycle. Hour 12 maps to 0 seconds (top of the
 * cycle), hours 1..11 map to 1*3600..11*3600.
 */
function hmsTotalSeconds(hms: { h: number; m: number; s: number }): number {
  return (hms.h % 12) * 3600 + hms.m * 60 + hms.s;
}

/**
 * Convert a unix-ms timestamp into HMS components matching what the
 * USER'S watch should be displaying at that moment, on the 12-hour
 * analog clock. When `clientTzOffsetMinutes` is provided, we shift
 * the timestamp by that offset before extracting H/M/S so a watch
 * displaying local time gets compared against local-clock HMS rather
 * than UTC-clock HMS.
 *
 * Background — PR #126 fix: prior to this helper, both /draft and
 * /confirm called `refDate.getUTCHours()` directly. For a user in
 * Lisbon WEST (+60 min) with a watch on local time, this produced a
 * predicted hour that was UTC-relative while the watch dial was
 * local-relative — so every reading had a 3600 s constant TZ-bias
 * baked into its `deviation_seconds`. Drift-rate math cancelled the
 * bias (constant offset), but per-reading absolute deviation looked
 * 1 hour off. The user noticed and reported it. The fix: SPA sends
 * `client_tz_offset_minutes` (DST-aware, captured via
 * `-new Date(captureMs).getTimezoneOffset()`), persisted in the
 * reading-token, and threaded into both endpoints' HMS computation.
 *
 * Backward compat: when offset is undefined we fall back to UTC
 * components — matches the pre-#126 behaviour for any in-flight
 * tokens minted before the deploy.
 *
 * @param referenceMs unix ms (UTC, the moment the photo was captured)
 * @param clientTzOffsetMinutes  east-of-UTC offset in minutes; +60
 *   for WEST, +120 for CEST, −240 for EDT, etc. Optional.
 */
function referenceHmsForUserClock(
  referenceMs: number,
  clientTzOffsetMinutes?: number,
): { h: number; m: number; s: number } {
  // Shift the unix-ms forward into the user's local clock by adding
  // the offset. The resulting Date's `getUTC*()` methods now return
  // components that match what a watch in the user's TZ would
  // display at moment of capture.
  const shiftedMs =
    clientTzOffsetMinutes !== undefined
      ? referenceMs + clientTzOffsetMinutes * 60_000
      : referenceMs;
  const d = new Date(shiftedMs);
  const h24 = d.getUTCHours();
  // Map 0..23 → 12, 1..11, 12, 1..11 on the analog 12-hour dial.
  const h12 = ((h24 + 11) % 12) + 1;
  return { h: h12, m: d.getUTCMinutes(), s: d.getUTCSeconds() };
}

/**
 * Wrap-aware full-HMS deviation on the 12-hour analog cycle (43200
 * seconds). Returns the shortest signed distance (in seconds)
 * between two HH:MM:SS triples, always in [-21600, +21600].
 *
 * Used by /confirm to compute the saved `deviation_seconds`. PR
 * #122 graduated this from MM:SS-only (30-min wrap) to full HMS
 * (6-hour wrap) because the new UX lets the user adjust the hour
 * — a watch that's actually 1h fast must record as +3600s, not
 * wrap modulo-30-min into a near-zero value.
 *
 * Timezone handling now lives in `referenceHmsForUserClock` (PR
 * #126). The reference HMS passed in here is already in the user's
 * watch-clock frame, so the deviation calculation itself is a pure
 * digit-vs-digit comparison.
 */
function compute12HourDeviation(
  dial: { h: number; m: number; s: number },
  ref: { h: number; m: number; s: number },
): number {
  const dialTotal = hmsTotalSeconds(dial);
  const refTotal = hmsTotalSeconds(ref);
  const raw = dialTotal - refTotal;
  // Map raw delta into [-21600, +21600] via the canonical wrap idiom.
  // Half-cycle = 21600 (= 6 hours), full cycle = 43200 (= 12 hours).
  const wrapped = (((raw + 21600) % 43200) + 43200) % 43200;
  return wrapped - 21600;
}

/**
 * POST /verified/draft — run the VLM pipeline, return a signed
 * `reading_token` + predicted MM:SS + photo URL. Does NOT persist
 * a reading.
 *
 * Error mapping:
 *   * 400 + error: "image_required"               — no image on form
 *   * 413 + error: "image_too_large"               — > 10 MB
 *   * 422 + error: "exif_clock_skew"               — EXIF outside bounds
 *   * 422 + error_code: "ai_unparseable" + retake reason
 *                                                  — VLM didn't emit HH:MM:SS
 *   * 502 + error_code: "dial_reader_transport_error" — upstream blew up
 *
 * On success returns 200 with:
 *   {
 *     reading_token: string,
 *     predicted_mm_ss: { m, s },
 *     photo_url: string,
 *     hour_from_server_clock: number,   // 0–23 UTC; SPA renders
 *                                       // the hour the user can't change
 *     reference_source: "exif" | "server",
 *     expires_at_unix: number,
 *   }
 */
readingsByWatchRoute.post("/verified/draft", async (c) => {
  // Capture wall-clock immediately. See AGENTS.md and verifier
  // docstring — multipart parse can take seconds, and we don't
  // want upload latency leaking into the reference timestamp.
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

  // Optional `client_capture_ms` form field. PR #124 fix for the
  // upload-latency bias: the SPA's canvas-resize step strips EXIF
  // from every photo, so the byte-EXIF path almost always falls
  // through to server arrival, biasing every reading by 5-15 s of
  // upload time. The SPA now extracts EXIF DateTimeOriginal from the
  // ORIGINAL bytes (or `Date.now()` at file selection as a fallback)
  // and posts it here. Server bounds it the same way as byte-EXIF
  // (±5 min / +1 min) — same anti-cheat envelope.
  //
  // We treat a present-but-unparseable value as an invalid request
  // rather than silently ignoring it: a malformed field means the
  // SPA's contract drifted from the server's, and silently falling
  // back would re-introduce the latency bias.
  const clientCaptureMsRaw = form.get("client_capture_ms");
  let clientCaptureMs: number | undefined;
  if (typeof clientCaptureMsRaw === "string" && clientCaptureMsRaw.length > 0) {
    const parsed = Number(clientCaptureMsRaw);
    if (!Number.isFinite(parsed)) {
      return c.json({ error: "invalid_input", field: "client_capture_ms" }, 400);
    }
    clientCaptureMs = parsed;
  }

  // Optional `client_tz_offset_minutes` form field. PR #126 fix for
  // the TZ-bias-as-deviation report: a watch on Lisbon local
  // (UTC+1) compared against a UTC-derived reference produces
  // every reading with a 3600 s constant offset baked in. Drift
  // rate cancels it, but per-reading absolute deviation looks 1 h
  // off. The SPA captures
  //   `-new Date(captureMs).getTimezoneOffset()`
  // which is DST-aware (the offset that was in effect at the moment
  // of capture, not at handler-entry time). Server bounds it to
  // ±840 minutes (covers all real TZs incl. UTC+14 / UTC−12).
  //
  // Same "invalid → 400" treatment as `client_capture_ms` — a SPA
  // that drifts out of contract should fail loud, not silently
  // produce TZ-biased readings.
  const clientTzOffsetMinutesRaw = form.get("client_tz_offset_minutes");
  let clientTzOffsetMinutes: number | undefined;
  if (
    typeof clientTzOffsetMinutesRaw === "string" &&
    clientTzOffsetMinutesRaw.length > 0
  ) {
    const parsed = Number(clientTzOffsetMinutesRaw);
    if (!Number.isFinite(parsed) || parsed < -840 || parsed > 840) {
      return c.json({ error: "invalid_input", field: "client_tz_offset_minutes" }, 400);
    }
    clientTzOffsetMinutes = parsed;
  }

  const imageBuffer = await image.arrayBuffer();

  const aiGatewayId = c.env.AI_GATEWAY_ID ?? "dial-reader-bakeoff";
  const result = await verifyVlmReadingFromEnv(
    {
      photoBytes: imageBuffer,
      watchId,
      userId: user.id,
      serverArrivalAtMs: serverArrivalMs,
      clientCaptureMs,
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

  // Persist the photo to the draft prefix. The lifecycle rule on
  // `drafts/` (24h TTL — see infra/terraform/r2.tf) cleans up
  // abandoned drafts. Failure here is fatal to /draft because we
  // need a working photo URL to return to the SPA.
  const draftPhotoUuid = crypto.randomUUID();
  const draftKey = `drafts/${user.id}/${draftPhotoUuid}.jpg`;
  try {
    await c.env.WATCH_IMAGES.put(draftKey, imageBuffer, {
      httpMetadata: { contentType: image.type || "image/jpeg" },
    });
  } catch (err) {
    console.warn(
      `verified-reading: R2 PUT failed for draft ${draftKey}, returning 502:`,
      err,
    );
    return c.json(
      {
        error_code: "dial_reader_transport_error",
        ux_hint: "Couldn't store your photo. Please try again.",
      },
      502,
    );
  }

  const expiresAtUnix = Math.floor(Date.now() / 1000) + READING_TOKEN_TTL_SECONDS;

  // Convert the reference timestamp to a 12-hour analog HOUR position
  // matching what the user's watch should be displaying. The VLM's
  // mm_ss read is paired with this hour to produce the predicted
  // analog dial display the SPA shows in the confirmation page.
  //
  // PR #122 added per-component HH/MM/SS adjusters. PR #126 added the
  // optional `clientTzOffsetMinutes` shift so watches on local time
  // (e.g. Lisbon WEST) get a predicted hour that matches their dial
  // rather than UTC's. The minute/second components come straight
  // from the VLM's mm_ss read (TZ doesn't affect MM:SS for any real
  // TZ — they're all whole-hour or whole-half-hour offsets, and the
  // half-hour cases round trivially since we never cross 30 min).
  const refHmsAtUserClock = referenceHmsForUserClock(
    result.reference_timestamp_ms,
    clientTzOffsetMinutes,
  );
  const predictedHms = {
    h: refHmsAtUserClock.h,
    m: result.mm_ss.m,
    s: result.mm_ss.s,
  };

  const tokenPayload: ReadingTokenPayload = {
    photo_r2_key: draftKey,
    anchor_hms: formatHms(result.reference_timestamp_ms),
    reference_ms: result.reference_timestamp_ms,
    predicted_hms: predictedHms,
    user_id: user.id,
    watch_id: watchId,
    expires_at_unix: expiresAtUnix,
    vlm_model: result.vlm_model,
    // PR #126: persist client TZ offset so /confirm reproduces the
    // same local-clock reference HMS used here for predicted_hms.h.
    // Optional — pre-#126 SPAs omit it.
    client_tz_offset_minutes: clientTzOffsetMinutes,
  };
  const readingToken = await signReadingToken(tokenPayload, c.env.READING_TOKEN_SECRET);

  // Photo URL — the SPA fetches the draft photo from `/images/`
  // (see src/server/routes/images.ts). Slice #7 will wire the
  // confirmation page to this URL; for now we return the absolute
  // URL based on the request origin.
  const requestUrl = new URL(c.req.url);
  const photoUrl = `${requestUrl.origin}/images/${draftKey}`;

  await logEvent("verified_reading_drafted", { userId: user.id, watchId }, c.env);

  return c.json(
    {
      reading_token: readingToken,
      // PR #122: return full predicted HH:MM:SS (12-hour) so the
      // SPA can pre-populate the per-component up/down adjusters.
      // `hour_from_server_clock` (24-hour UTC) was previously
      // returned alongside `predicted_mm_ss`; merging them into a
      // single `predicted_hms` removes the back-and-forth
      // 12h/24h conversion the SPA was doing.
      predicted_hms: predictedHms,
      photo_url: photoUrl,
      reference_source: result.reference_source,
      expires_at_unix: expiresAtUnix,
    },
    200,
  );
});

/**
 * POST /verified/confirm — accept the user's (possibly adjusted)
 * MM:SS, validate against the signed token, save the reading, and
 * move the photo to the verified prefix.
 *
 * Error mapping:
 *   * 400 invalid_input          — Zod validation failed
 *   * 401 invalid_token          — bad signature, expired, or
 *                                  missing READING_TOKEN_SECRET
 *   * 403 forbidden              — token user_id/watch_id doesn't
 *                                  match the request session/URL
 *
 * PR #122 removed the `422 adjustment_too_large` branch (no more
 * ±30s cap; any well-shaped HH:MM:SS triple is accepted).
 *
 * On success returns 201 with the saved reading row (same shape
 * as the manual POST).
 */
readingsByWatchRoute.post("/verified/confirm", async (c) => {
  const user = c.get("user");
  const watchId = getWatchIdParam(c);
  if (!watchId) return c.json({ error: "not_found" }, 404);

  const db = createDb(c.env);
  const ownership = await assertWatchOwnership(db, watchId, user.id);
  if (ownership.status === "not_found") {
    return c.json({ error: "not_found" }, 404);
  }
  if (ownership.status === "forbidden") {
    return c.json({ error: "forbidden" }, 403);
  }

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = confirmReadingSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_input",
        fieldErrors: parsed.error.issues,
      },
      400,
    );
  }
  const { reading_token, final_hms, is_baseline } = parsed.data;

  const payload = await verifyReadingToken(reading_token, c.env.READING_TOKEN_SECRET);
  if (!payload) {
    await logEvent(
      "verified_reading_confirm_rejected",
      { userId: user.id, watchId, reason: "invalid_token" },
      c.env,
    );
    return c.json({ error: "invalid_token" }, 401);
  }

  // Cross-check token payload against the request. A token signed
  // for a different user or watch is suspicious and gets a 403
  // rather than 401 — the signature is fine, the *use* is wrong.
  if (payload.user_id !== user.id || payload.watch_id !== watchId) {
    await logEvent(
      "verified_reading_confirm_rejected",
      {
        userId: user.id,
        watchId,
        reason: "token_subject_mismatch",
      },
      c.env,
    );
    return c.json({ error: "forbidden" }, 403);
  }

  // PR #122 removed the ±30s adjustment cap. The Zod schema's
  // shape validation (h ∈ [1,12], m/s ∈ [0,59]) is the only
  // server-side bound now. Defense-in-depth comes from:
  //   * The reading-token's HMAC + 5-min expiry above.
  //   * The photo persisted to R2 (audit trail).
  //   * Auth + ownership + rate-limit checks earlier in the
  //     handler.
  // The cap was always more about UI nudge than fraud prevention
  // — a determined cheater knows the rough current time anyway.
  // Real fraud would surface as a watch with consistently exact
  // server-clock readings (no drift) which is itself a detection
  // signal in the leaderboard.

  // Build the reference HMS from the token's stored reference_ms,
  // shifted into the user's local-clock frame using the same TZ
  // offset that was used when /draft minted `predicted_hms.h`.
  // Without this shift, a watch on local time (e.g. Lisbon WEST,
  // +60 min) ends up with a 3600 s constant TZ-bias added to every
  // saved deviation. PR #126.
  const referenceHms = referenceHmsForUserClock(
    payload.reference_ms,
    payload.client_tz_offset_minutes,
  );

  const deviationSeconds = is_baseline
    ? 0
    : compute12HourDeviation(final_hms, referenceHms);

  // The reference timestamp on the row is the actual ms the photo
  // was captured (stored in the token at /draft time). PR #122 no
  // longer reconstructs from a string — the token carries the
  // precise ms.
  const referenceMs = payload.reference_ms;

  const id = crypto.randomUUID();
  await db
    .insertInto("readings")
    .values({
      id,
      watch_id: watchId,
      user_id: user.id,
      reference_timestamp: referenceMs,
      deviation_seconds: deviationSeconds,
      is_baseline: is_baseline ? 1 : 0,
      verified: 1,
      notes: null,
      vlm_model: payload.vlm_model,
    })
    .execute();

  // Move the photo from drafts/ to verified/. R2 has no native
  // server-side rename; we copy + delete. Idempotent — if the
  // verified key already exists we re-write the same bytes (no
  // harm) and the delete on a missing draft key is a no-op.
  const verifiedKey = `verified/${user.id}/${id}.jpg`;
  let photoMoved = false;
  try {
    const draft = await c.env.WATCH_IMAGES.get(payload.photo_r2_key);
    if (draft) {
      const draftBytes = await draft.arrayBuffer();
      await c.env.WATCH_IMAGES.put(verifiedKey, draftBytes, {
        httpMetadata: draft.httpMetadata,
      });
      await c.env.WATCH_IMAGES.delete(payload.photo_r2_key);
      photoMoved = true;
    } else {
      // Draft photo expired between draft and confirm (24h TTL).
      // The reading row stays — the photo is provenance, not
      // the canonical record — but we surface a warning.
      console.warn(
        `verified-reading: draft photo missing on confirm for reading ${id} (key=${payload.photo_r2_key})`,
      );
    }
  } catch (err) {
    console.warn(
      `verified-reading: R2 photo move failed for reading ${id}, continuing:`,
      err,
    );
  }

  if (photoMoved) {
    await db
      .updateTable("readings")
      .set({ photo_r2_key: verifiedKey })
      .where("id", "=", id)
      .execute();
  }

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
    { userId: user.id, watchId, is_baseline: is_baseline === true },
    c.env,
  );

  return c.json(toResponse(created), 201);
});

// PR #122: removed `parseHms`/`reconstructReferenceMs` — the token
// now carries `reference_ms` directly so /confirm doesn't have to
// reconstruct the timestamp from a HH:MM:SS string + today's date.
// Old behaviour was a small fudge that drifted by token-TTL (~5
// min) for the saved row's `reference_timestamp`; the new path is
// exact.

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
      retake: true,
      reason: "unreadable_photo",
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
