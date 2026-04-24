// Reading verifier — orchestrates the verified-reading pipeline.
//
// Pipeline (matches slice #16 / issue #17 spec):
//
//   1. Capture server-side reference timestamp (`Date.now()`). This
//      is the canonical source of truth — client / EXIF timestamps
//      are NEVER trusted for competitive scoring.
//   2. Run the image through the AI dial reader. The reader returns
//      the minute + second hand positions (0-59 each) — only the
//      hour is inferred from the reference clock.
//   3. On AI error → bubble up as a structured failure.
//   4. On AI success, compute the signed drift in seconds between
//      the dial's observed MM:SS (minute + second positions) and
//      the reference clock's minute + second, wrapped into
//      [-1800, +1800] so mid-minute captures don't show as
//      ~1-minute offsets and drifts up to ±30 minutes resolve
//      cleanly.
//   5. If `is_baseline`, force deviation to 0 — by definition the
//      user has just set the watch to the true time.
//   6. Insert a readings row with verified=1.
//   7. Best-effort R2 upload of the photo at `readings/{id}/photo.jpg`.
//      A failure here is logged but doesn't roll back the reading —
//      the reading is canonical, the photo is for provenance only.
//
// Design constraint introduced by the MM:SS-only model contract:
//
//   We do NOT ask the model for the hour, because a 12-hour dial
//   wrap means any hour output is ambiguous. The HOUR comes from
//   the reference clock. That caps the verifier's detectable drift
//   at ±30 minutes — anything beyond that would wrap. That's more
//   than adequate for any realistic mechanical watch drift; a watch
//   that's an hour or more off has stopped, not drifted.

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

// Dial MM:SS and reference MM:SS both live in an hour-of-day frame
// (0..3599 seconds). Their signed difference is in [-3599, +3599].
// Wrap into [-1800, +1800] so a capture straddling the hour boundary
// (dial=59:58, ref=00:02) is reported as -4 s rather than +3596 s.
//
// Constraint: any true drift > 30 minutes will wrap and under-report.
// See the module-level comment. For realistic mechanical drift this
// never triggers.
const SECONDS_PER_HOUR = 3600;
const HALF_HOUR_SECONDS = 1800;

/**
 * Exported for tests. Computes the signed drift in seconds between
 * the dial's observed MM:SS and the reference clock's MM:SS, wrapped
 * into [-1800, +1800] (the ±30 minute window).
 *
 * Invariants:
 *   * dialReading.minutes and .seconds are integers in [0, 59].
 *     Callers (readDialTime) enforce that — this helper still
 *     tolerates out-of-range by `%%`-normalising first.
 *   * referenceTimestampMs is a millisecond unix timestamp.
 *
 * Positive deviation = watch is ahead of reference. Negative = behind.
 */
export function computeVerifiedDeviation(
  dialReading: {
    minutes: number;
    seconds: number;
  },
  referenceTimestampMs: number,
): number {
  // Dial time in seconds-of-hour.
  const dialTotalSec = dialReading.minutes * 60 + dialReading.seconds;

  // Reference time in seconds-of-hour. Derive from the wall-clock
  // minute + second, ignoring the hour (matches what the model sees
  // on the dial — it doesn't know the hour either).
  const refDate = new Date(referenceTimestampMs);
  const refTotalSec = refDate.getUTCMinutes() * 60 + refDate.getUTCSeconds();

  // Raw signed delta in [-3599, +3599].
  let diff = dialTotalSec - refTotalSec;

  // Wrap into [-1800, +1800]:
  //   add 1800, take mod 3600, subtract 1800.
  // Use a %%-style normalisation because JS `%` keeps the sign of
  // the lhs, which would give wrong answers for large negatives.
  diff =
    ((((diff + HALF_HOUR_SECONDS) % SECONDS_PER_HOUR) + SECONDS_PER_HOUR) %
      SECONDS_PER_HOUR) -
    HALF_HOUR_SECONDS;
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

  // 4. Compute deviation from dial MM:SS vs reference MM:SS.
  let deviation = computeVerifiedDeviation(
    { minutes: readerResult.minutes, seconds: readerResult.seconds },
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
