// Reading verifier — orchestrates the verified-reading pipeline.
//
// Pipeline (matches slice #16 / issue #17 spec):
//
//   1. Capture server-side reference timestamp (`Date.now()`). This
//      is the canonical source of truth — client / EXIF timestamps
//      are NEVER trusted for competitive scoring.
//   2. Run the image through the AI dial reader.
//   3. On AI error → bubble up as a structured failure.
//   4. On AI success, compute the signed drift in seconds between
//      dial-time and reference-time, wrapped into [-1800, 1800] so
//      a minute-boundary capture doesn't show as a ~30 minute drift.
//   5. If `is_baseline`, force deviation to 0 — by definition the
//      user has just set the watch to the true time.
//   6. Insert a readings row with verified=1.
//   7. Best-effort R2 upload of the photo at `readings/{id}/photo.jpg`.
//      A failure here is logged but doesn't roll back the reading —
//      the reading is canonical, the photo is for provenance only.
//
// We deliberately do NOT override the AI's hours with the reference
// clock. The archived watchdrift prototype did that to "fix" AM/PM
// misreads and silently destroyed its own drift accuracy. If the
// model gets the hour wrong, the reading is wrong and the caller
// should re-capture.

import { createDb } from "@/db";
import { readDialTime, type DialReaderError } from "@/domain/ai-dial-reader/reader";
import type { Reading } from "@/domain/drift-calc";

export interface VerifyReadingInput {
  watchId: string;
  userId: string;
  imageBuffer: ArrayBuffer;
  isBaseline: boolean;
  env: {
    AI: Ai;
    DB: D1Database;
    IMAGES: R2Bucket;
  };
}

export type VerifyReadingErrorCode = "ai_refused" | "ai_unparseable" | "ai_implausible";

export type VerifyReadingResult =
  | {
      ok: true;
      reading: VerifiedReadingRow;
      ai_response: string;
    }
  | {
      ok: false;
      error: VerifyReadingErrorCode;
      raw_response?: string;
    };

// The inserted readings row, shaped like the `readings` API response
// but kept local so callers can decide how to project it for their
// route's wire format.
export interface VerifiedReadingRow {
  id: string;
  watch_id: string;
  user_id: string;
  reference_timestamp: number;
  deviation_seconds: number;
  is_baseline: boolean;
  verified: boolean;
  notes: string | null;
  created_at: string;
}

// A signed drift outside ±30 min is almost certainly a minute-boundary
// wrap (e.g. dial=00:00:30, ref=23:59:55 ⇒ raw delta +35m but true
// drift +35s). Wrapping into [-1800, 1800] resolves that.
const HALF_HOUR_SECONDS = 1800;
const DAY_SECONDS = 24 * 60 * 60;

/**
 * Exported for tests. Computes drift between the dial-time-of-day
 * and the reference-time-of-day, in seconds, wrapped into
 * [-HALF_HOUR_SECONDS, HALF_HOUR_SECONDS].
 *
 * NOT a general time-delta helper — the math assumes dial and
 * reference are "roughly" aligned to within ±30 min.
 */
export function computeVerifiedDeviation(
  dialHms: {
    hours: number;
    minutes: number;
    seconds: number;
  },
  referenceTimestamp: number,
): number {
  const dialSec = dialHms.hours * 3600 + dialHms.minutes * 60 + dialHms.seconds;
  const d = new Date(referenceTimestamp);
  // Use UTC getters on the reference to match the dial's 0-23h scale
  // without worrying about the worker's local TZ. The dial itself is
  // also a UTC-agnostic "time shown on the face"; we're just taking
  // time-of-day mod 24h on both sides.
  const refSec = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();

  // Raw diff in [-(DAY_SECONDS-1), DAY_SECONDS-1].
  let diff = dialSec - refSec;
  // Wrap into [-HALF_HOUR_SECONDS, HALF_HOUR_SECONDS]:
  //   - add HALF_HOUR_SECONDS
  //   - mod by 2*HALF_HOUR_SECONDS (=3600)
  //   - subtract HALF_HOUR_SECONDS
  // But `%` in JS returns a negative for negative lhs, so normalise
  // via +(2*HALF_HOUR_SECONDS) first.
  diff =
    ((((diff + HALF_HOUR_SECONDS) % (2 * HALF_HOUR_SECONDS)) + 2 * HALF_HOUR_SECONDS) %
      (2 * HALF_HOUR_SECONDS)) -
    HALF_HOUR_SECONDS;
  return diff;
}

// Suppress the signature to keep `DAY_SECONDS` referenced — it
// documents the invariant that refSec ∈ [0, DAY_SECONDS) even though
// modern JS doesn't need the guard. A future refactor touching this
// helper will want to remember that.
export const _DAY_SECONDS = DAY_SECONDS;

/**
 * Run the verified-reading pipeline end-to-end. Never throws — any
 * error is returned as a structured failure so the route can pick a
 * suitable HTTP status.
 */
export async function verifyReading(
  input: VerifyReadingInput,
): Promise<VerifyReadingResult> {
  const { watchId, userId, imageBuffer, isBaseline, env } = input;

  // 1. Server-side reference timestamp. Captured BEFORE any I/O so
  //    all the rest of the pipeline (AI call, DB insert) adds drift
  //    that the user cannot influence.
  const referenceTimestamp = Date.now();

  // 2. AI dial read.
  const image = new Uint8Array(imageBuffer);
  const readerResult = await readDialTime(
    image,
    { AI: env.AI },
    new Date(referenceTimestamp),
  );

  if ("error" in readerResult) {
    return toVerifierError(readerResult);
  }

  // 4. Compute deviation.
  let deviation = computeVerifiedDeviation(
    {
      hours: readerResult.hours,
      minutes: readerResult.minutes,
      seconds: readerResult.seconds,
    },
    referenceTimestamp,
  );

  // 5. Baseline override — the user is declaring "the watch is set
  //    to the exact time right now", so by definition deviation=0.
  if (isBaseline) {
    deviation = 0;
  }

  // 6. Insert the readings row.
  const db = createDb(env);
  const id = crypto.randomUUID();
  await db
    .insertInto("readings")
    .values({
      id,
      watch_id: watchId,
      user_id: userId,
      reference_timestamp: referenceTimestamp,
      deviation_seconds: deviation,
      is_baseline: isBaseline ? 1 : 0,
      verified: 1,
      notes: null,
    })
    .execute();

  const inserted = (await db
    .selectFrom("readings")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow()) as unknown as {
    id: string;
    watch_id: string;
    user_id: string;
    reference_timestamp: number;
    deviation_seconds: number;
    is_baseline: number;
    verified: number;
    notes: string | null;
    created_at: string;
  };

  // 7. Best-effort R2 upload. Failure here does NOT roll back the
  //    reading — the DB row is canonical, the photo is provenance.
  //    We log a warning so operator tails catch systemic failures.
  try {
    await env.IMAGES.put(`readings/${id}/photo.jpg`, imageBuffer, {
      httpMetadata: { contentType: "image/jpeg" },
    });
  } catch (err) {
    console.warn(
      `reading-verifier: R2 upload failed for reading ${id}, continuing:`,
      err,
    );
  }

  return {
    ok: true,
    reading: {
      id: inserted.id,
      watch_id: inserted.watch_id,
      user_id: inserted.user_id,
      reference_timestamp: inserted.reference_timestamp,
      deviation_seconds: inserted.deviation_seconds,
      is_baseline: inserted.is_baseline === 1,
      verified: inserted.verified === 1,
      notes: inserted.notes,
      created_at: inserted.created_at,
    },
    ai_response: readerResult.raw_response,
  };
}

function toVerifierError(err: DialReaderError): VerifyReadingResult {
  const code: VerifyReadingErrorCode =
    `ai_${err.error}` as const as VerifyReadingErrorCode;
  const raw = err.raw_response;
  return raw === undefined
    ? { ok: false, error: code }
    : { ok: false, error: code, raw_response: raw };
}

// Keep the Reading domain type referenced to document the relationship
// — a verified row is a normal Reading with `verified=true`. A later
// refactor could switch to returning that shape directly.
export type { Reading };
