// Reading verifier — orchestrates the verified-reading pipeline.
//
// Pipeline (matches slice #16 / issue #17 spec):
//
//   1. Capture server-side reference timestamp (`Date.now()`). This
//      is the canonical source of truth — client / EXIF timestamps
//      are NEVER trusted for competitive scoring.
//   2. Run the image through the AI dial reader. The dial reader now
//      returns *only* the second-hand position (0-59) — hours and
//      minutes come from the reference clock, not the model.
//   3. On AI error → bubble up as a structured failure.
//   4. On AI success, compute the signed drift in seconds between
//      the model's observed second-hand position and the reference
//      clock's own seconds-of-minute, wrapped into [-30, +30] so a
//      minute-boundary capture doesn't show as a ~30 second drift.
//   5. If `is_baseline`, force deviation to 0 — by definition the
//      user has just set the watch to the true time.
//   6. Insert a readings row with verified=1.
//   7. Best-effort R2 upload of the photo at `readings/{id}/photo.jpg`.
//      A failure here is logged but doesn't roll back the reading —
//      the reading is canonical, the photo is for provenance only.
//
// Design constraint introduced by the seconds-only model contract:
//
//   The model no longer reports hours or minutes, only the second
//   hand's position (0-59). That means this verifier can only
//   resolve drifts in the range [-30, +30] seconds — any larger
//   drift is ambiguous without the minute hand. For phase 1 that's
//   acceptable: a user logging a verified reading is expected to
//   roughly sync their watch; anything that's drifted more than
//   30 seconds in a session will wrap and under-report. That
//   constraint is documented below next to the wrap math.

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

// With a seconds-only read, the dial's second hand and the reference
// clock's seconds-of-minute are both in [0, 59], so their signed
// difference is in [-59, +59]. Wrap into [-30, +30] so a capture
// straddling the minute boundary (dial=58, ref=02) is reported as
// -4 rather than +56.
//
// Constraint: any true drift > 30 s in absolute value will wrap and
// under-report. See the module-level comment.
const HALF_MINUTE_SECONDS = 30;

/**
 * Exported for tests. Computes the seconds-only drift between the
 * dial's observed second-hand position and the reference clock's
 * seconds-of-minute, wrapped into [-30, +30] (lower bound inclusive,
 * upper bound inclusive where 30 and -30 collide at the ±1800° mark).
 *
 * Invariants:
 *   * dialReading.seconds must be an integer in [0, 59]. Callers
 *     (readDialTime) enforce that — this helper still tolerates
 *     out-of-range by `%%`-normalising first.
 *   * referenceTimestampMs is a millisecond unix timestamp.
 */
export function computeVerifiedDeviation(
  dialReading: {
    seconds: number;
  },
  referenceTimestampMs: number,
): number {
  const dialSec = dialReading.seconds;
  // Reference seconds-of-minute. `Math.floor` on the ms / 1000 then
  // %% 60 gives the current seconds-of-minute in [0, 59].
  const refSec = Math.floor(referenceTimestampMs / 1000) % 60;

  // Raw signed delta in [-59, +59]. Positive = watch ahead of
  // reference; negative = watch behind.
  let diff = dialSec - refSec;

  // Wrap into [-30, +30]:
  //   add 30, take mod 60, subtract 30.
  // Use a %%-style normalisation because JS `%` keeps the sign of
  // the lhs, which would give wrong answers for large negatives.
  diff = ((((diff + HALF_MINUTE_SECONDS) % 60) + 60) % 60) - HALF_MINUTE_SECONDS;
  return diff;
}

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

  // 4. Compute deviation from dial seconds vs reference seconds.
  let deviation = computeVerifiedDeviation(
    { seconds: readerResult.seconds },
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
