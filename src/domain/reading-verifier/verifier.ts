// Reading verifier — orchestrates the verified-reading pipeline.
//
// Pipeline (matches slice #16 / issue #17 spec, with the EXIF
// reference-timestamp change layered on top):
//
//   1. Reference timestamp resolution.
//      We try to read EXIF DateTimeOriginal (the moment the shutter
//      fired) from the image bytes. When present and within the
//      bounds window vs server arrival time, that's the reference.
//      When missing, we fall back to server arrival time (captured
//      at handler entry, BEFORE the formData await — see the route).
//      When present but outside bounds, the request is rejected.
//
//      Why we changed: the previous implementation captured
//      `Date.now()` AFTER awaiting the multipart body. On cellular
//      with a 2 MB photo that's 2-8 s of phantom drift baked into
//      every reading. EXIF DateTimeOriginal is the moment the
//      shutter fired and is upload-latency-immune. The trust
//      trade-off (an attacker with control over their phone clock
//      can fake deviations within the bounds window) is documented
//      in AGENTS.md.
//   2. Run the image through the CV dial-reader container.
//      Returns a structured `displayed_time: { h, m, s }` plus a
//      confidence score and a version string.
//
//      Slice #11 (cutover) of PRD #73 deleted the legacy Workers AI
//      runner — the CV container is now the only backend.
//   3. On reader error → bubble up as a structured failure.
//   4. On reader success, compute the signed drift in seconds
//      between the dial's observed MM:SS (minute + second
//      positions) and the reference clock's minute + second,
//      wrapped into [-1800, +1800] so mid-minute captures don't
//      show as ~1-minute offsets and drifts up to ±30 minutes
//      resolve cleanly. The container returns an `h` field too;
//      the verifier deliberately ignores it (see the design
//      constraint below).
//   5. If `is_baseline`, force deviation to 0 — by definition the
//      user has just set the watch to the true time.
//   6. Insert a readings row with verified=1. The row carries
//      `photo_r2_key`, `dial_reader_confidence`, and
//      `dial_reader_version` (columns added in
//      migrations/0007_verified_reading_cv.sql).
//   7. Best-effort R2 upload of the photo at `readings/{id}/photo.jpg`.
//      A failure here is logged but doesn't roll back the reading —
//      the reading is canonical, the photo is for provenance only.
//
// Design constraint introduced by the MM:SS-only model contract:
//
//   We do NOT trust the container's hour reading, because a 12-hour
//   dial wrap means any hour output is ambiguous. The HOUR comes
//   from the reference clock. That caps the verifier's detectable
//   drift at ±30 minutes — anything beyond that would wrap. That's
//   more than adequate for any realistic mechanical watch drift; a
//   watch that's an hour or more off has stopped, not drifted. The
//   CV container returns `h` because the internal hour-hand read is
//   part of the confidence signal (hour-hand position must agree
//   with minute-hand position) — but only `m` and `s` flow
//   downstream from this verifier.

import { createDb } from "@/db";
import { readDial, type DialReaderEnv } from "@/domain/dial-reader";
import type { Reading } from "@/domain/drift-calc";
import { logEvent, type EventLoggerEnv } from "@/observability/events";
import { extractCaptureTimestampMs } from "./exif";

/**
 * Minimum confidence score we trust enough to call a CV success.
 * Below this we surface a structured `dial_reader_low_confidence`
 * rejection so the SPA can offer "retake / log manually" (PRD #73
 * User Story #8). 0.7 is the v1 threshold per PRD; tunable once we
 * have audit data on borderline reads.
 */
export const DIAL_READER_CONFIDENCE_THRESHOLD = 0.7;

export interface VerifyReadingInput {
  watchId: string;
  userId: string;
  imageBuffer: ArrayBuffer;
  isBaseline: boolean;
  /**
   * The wall-clock millisecond timestamp captured at route handler
   * entry, BEFORE awaiting the multipart body. Used as the fallback
   * reference when EXIF is missing, and as the bounds anchor when
   * EXIF is present. Capturing this in the route — not here —
   * sidesteps the upload-latency phantom drift bug (#TBD): a
   * `Date.now()` inside this function would have included the
   * formData parse time on cellular.
   */
  serverArrivalMs: number;
  env: {
    DB: D1Database;
    IMAGES: R2Bucket;
  } & DialReaderEnv &
    EventLoggerEnv;
}

export type VerifyReadingErrorCode =
  | "exif_clock_skew"
  | "dial_reader_unsupported_dial"
  | "dial_reader_low_confidence"
  | "dial_reader_no_dial_found"
  | "dial_reader_malformed_image"
  | "dial_reader_transport_error";

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
      // Slice #81 (PRD #73): CV metadata surfaced on the failure
      // branch so the route can pass it to `corpus.maybeIngest`
      // without re-running the dial reader. Both fields are NULL
      // on the EXIF skew branch (where the dial reader never ran)
      // and on pure transport errors (the container never returned
      // a confidence). On structured rejections / low-confidence
      // success rejections they are populated.
      dial_reader_confidence?: number | null;
      dial_reader_version?: string | null;
    };

// The inserted readings row, shaped like the `readings` API response
// but kept local so callers can decide how to project it for their
// route's wire format.
//
// The three CV-specific fields (`photo_r2_key`, `dial_reader_*`)
// are nullable on the schema because earlier rows (manual readings,
// the AI-era era, …) didn't have them. Verified-reading rows always
// populate them.
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
  photo_r2_key: string | null;
  dial_reader_confidence: number | null;
  dial_reader_version: string | null;
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

// EXIF clock-skew bounds.
//
// We accept EXIF DateTimeOriginal as the reference timestamp when it
// is within `[server - 5 min, server + 1 min]`. The asymmetric window
// reflects how phones drift in practice:
//
//   * The 5-minute past tolerance covers the realistic upload-delay
//     band (cellular, retries, queued uploads on poor connectivity)
//     plus a small phone-clock-behind-server allowance.
//   * The 1-minute future tolerance covers small clock skew from
//     phones whose NTP-synced clock is marginally ahead of the
//     server. We don't allow much because EXIF "in the future"
//     beyond a minute is almost always a sign of a misset clock or
//     a deliberate spoof attempt.
//
// The bounds are inclusive on accept side: `delta == -5min` and
// `delta == +1min` both pass. A delta of `-5min - 1ms` or
// `+1min + 1ms` is rejected.
const EXIF_MAX_AGE_MS = 5 * 60 * 1000;
const EXIF_MAX_FUTURE_MS = 1 * 60 * 1000;

/**
 * Exported for tests. Computes the signed drift in seconds between
 * the dial's observed MM:SS and the reference clock's MM:SS, wrapped
 * into [-1800, +1800] (the ±30 minute window).
 *
 * Invariants:
 *   * dialReading.minutes and .seconds are integers in [0, 59].
 *     Callers (the dial reader) enforce that — this helper still
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
  const { watchId, userId, imageBuffer, isBaseline, serverArrivalMs, env } = input;

  // 1. Resolve the reference timestamp. EXIF preferred (upload-latency
  //    immune), bounded against server clock; server arrival is the
  //    fallback when EXIF is missing.
  const exifMs = await extractCaptureTimestampMs(imageBuffer);
  let referenceTimestamp: number;
  if (exifMs === null) {
    referenceTimestamp = serverArrivalMs;
    await logEvent("verified_reading_exif_missing", { userId, watchId }, env);
  } else {
    const delta = exifMs - serverArrivalMs;
    if (delta < -EXIF_MAX_AGE_MS) {
      await logEvent(
        "verified_reading_exif_clock_skew",
        { userId, watchId, delta_ms: delta },
        env,
      );
      return {
        ok: false,
        error: "exif_clock_skew",
        raw_response: `EXIF too old: ${delta}ms`,
      };
    }
    if (delta > EXIF_MAX_FUTURE_MS) {
      await logEvent(
        "verified_reading_exif_clock_skew",
        { userId, watchId, delta_ms: delta },
        env,
      );
      return {
        ok: false,
        error: "exif_clock_skew",
        raw_response: `EXIF in future: +${delta}ms`,
      };
    }
    referenceTimestamp = exifMs;
    await logEvent("verified_reading_exif_ok", { userId, watchId, delta_ms: delta }, env);
  }

  // 2. Dial read via the CV container.
  //
  //    The reading_id is generated NOW (rather than at INSERT time)
  //    so the slice #83 dial-reader telemetry events can correlate
  //    against it even on the rejection / transport-error paths
  //    where no row is ever written. The same id flows into the
  //    INSERT below; readingId == readings.id is the contract that
  //    lets the operator SQL-join Analytics Engine onto the D1
  //    readings table.
  const readingId = crypto.randomUUID();
  const image = new Uint8Array(imageBuffer);
  const backendRead = await runDialReaderBackend(image, env, readingId);

  if (!backendRead.ok) {
    // Hoist the BackendRead failure straight onto the
    // VerifyReadingResult shape. Both shapes share the optional
    // `confidence` / `version` fields (slice #81) so the route
    // can hand the metadata to `corpus.maybeIngest` without
    // re-running the dial reader.
    return {
      ok: false,
      error: backendRead.error,
      raw_response: backendRead.raw_response,
      dial_reader_confidence: backendRead.confidence ?? null,
      dial_reader_version: backendRead.version ?? null,
    };
  }

  // 4. Compute deviation from dial MM:SS vs reference MM:SS. The
  //    container's `h` is deliberately discarded (see module-level
  //    comment).
  let deviation = computeVerifiedDeviation(
    { minutes: backendRead.minutes, seconds: backendRead.seconds },
    referenceTimestamp,
  );

  // 5. Baseline override — the user is declaring "the watch is set
  //    to the exact time right now", so by definition deviation=0.
  if (isBaseline) {
    deviation = 0;
  }

  // 6. Insert the readings row with the confidence + version
  //    metadata. `photo_r2_key` is filled in after the R2 upload
  //    below — best-effort so a failed upload leaves the row with
  //    NULL there, which is fine.
  //
  //    `id` is the reading_id we generated up-front so the
  //    Analytics Engine events from the CV path correlate to the
  //    same row.
  const db = createDb(env);
  const id = readingId;
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
      dial_reader_confidence: backendRead.confidence,
      dial_reader_version: backendRead.version,
    })
    .execute();

  // 7. Best-effort R2 upload. Failure here does NOT roll back the
  //    reading — the DB row is canonical, the photo is provenance.
  //    We log a warning so operator tails catch systemic failures.
  //    On success we record the key on the row so the corpus job
  //    (PRD User Story #30) can find it via the partial index.
  const photoKey = `readings/${id}/photo.jpg`;
  let storedPhotoKey: string | null = null;
  try {
    await env.IMAGES.put(photoKey, imageBuffer, {
      httpMetadata: { contentType: "image/jpeg" },
    });
    storedPhotoKey = photoKey;
    await db
      .updateTable("readings")
      .set({ photo_r2_key: photoKey })
      .where("id", "=", id)
      .execute();
  } catch (err) {
    console.warn(
      `reading-verifier: R2 upload failed for reading ${id}, continuing:`,
      err,
    );
  }

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
    photo_r2_key: string | null;
    dial_reader_confidence: number | null;
    dial_reader_version: string | null;
  };

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
      photo_r2_key: inserted.photo_r2_key ?? storedPhotoKey,
      dial_reader_confidence: inserted.dial_reader_confidence,
      dial_reader_version: inserted.dial_reader_version,
    },
    ai_response: backendRead.rawResponse,
  };
}

/**
 * Internal envelope normalising the CV-container reader output into
 * a shape the post-read pipeline consumes without having to know
 * the wire format. Kept after the slice-#11 cutover (which deleted
 * the AI runner) because a future second backend (e.g. an on-device
 * reader) would slot in here without changing the verifier core.
 *
 * `BackendRead` is intentionally NOT exported — it's a private
 * implementation detail of the verifier, not part of the public
 * contract.
 */
type BackendRead =
  | {
      ok: true;
      minutes: number;
      seconds: number;
      confidence: number | null;
      version: string | null;
      rawResponse: string;
    }
  | {
      ok: false;
      error: VerifyReadingErrorCode;
      raw_response?: string;
      // Slice #81 (PRD #73): propagate the CV-pipeline metadata
      // even on the failure branch so the route can pass it to
      // `corpus.maybeIngest`. Both fields are NULL on a pure
      // transport error / EXIF skew (the container either didn't
      // run or has no equivalent signal).
      confidence?: number | null;
      version?: string | null;
    };

/**
 * Map a CV-container rejection `reason` to a verifier-level error
 * code. The container sends a short string (per the FastAPI
 * contract in `container/dial-reader/src/dial_reader/http_app.py`);
 * this is the single place that translates it into the SPA-facing
 * vocabulary. Unknown reasons collapse to `dial_reader_no_dial_found`
 * — the most-actionable default ("retake your photo so the dial is
 * visible") and matches PRD #73 User Story #11.
 */
function mapDialReaderRejection(reason: string): VerifyReadingErrorCode {
  switch (reason) {
    case "sub_dial_detected":
    case "unsupported_format":
    case "unsupported_dial":
      return "dial_reader_unsupported_dial";
    case "low_confidence":
      return "dial_reader_low_confidence";
    case "no_dial_found":
      return "dial_reader_no_dial_found";
    case "malformed_image":
      return "dial_reader_malformed_image";
    default:
      return "dial_reader_no_dial_found";
  }
}

async function runDialReaderBackend(
  image: Uint8Array,
  env: DialReaderEnv & EventLoggerEnv,
  readingId: string,
): Promise<BackendRead> {
  // Pass the reading_id into the adapter so it can stamp the
  // slice-#83 telemetry events (dial_reader_attempt / _success /
  // _rejection / _error / _cold_start). The adapter handles the
  // entire emission story; the verifier only owns the correlation
  // key here.
  const result = await readDial(image, env, { readingId });
  if (result.kind === "transport_error") {
    return {
      ok: false,
      error: "dial_reader_transport_error",
      raw_response: result.message,
    };
  }
  if (result.kind === "rejection") {
    return {
      ok: false,
      error: mapDialReaderRejection(result.reason),
      raw_response: result.details ?? result.reason,
    };
  }
  if (result.kind === "malformed_image") {
    // Container surfaced a 400 — the bytes were corrupt, truncated,
    // or empty. Distinct from `transport_error` because retrying
    // with the same bytes can't help. SPA should ask the user for
    // a fresh capture (handled in slice #80's UX paths).
    return {
      ok: false,
      error: "dial_reader_malformed_image",
      raw_response: result.message,
    };
  }
  // Success branch. Apply the verifier-side confidence threshold
  // (PRD User Story #8): even a "successful" container response is
  // rejected if confidence is below 0.7.
  const body = result.body;
  if (body.result.confidence < DIAL_READER_CONFIDENCE_THRESHOLD) {
    return {
      ok: false,
      error: "dial_reader_low_confidence",
      raw_response: `confidence=${body.result.confidence}`,
      // Slice #81: surface the actual confidence + version so the
      // route's corpus-ingest call gets the same metadata as a
      // success path would. The corpus is most informative on
      // exactly these borderline reads.
      confidence: body.result.confidence,
      version: body.version,
    };
  }
  return {
    ok: true,
    minutes: body.result.displayed_time.m,
    seconds: body.result.displayed_time.s,
    confidence: body.result.confidence,
    version: body.version,
    rawResponse: `${body.result.displayed_time.m}:${body.result.displayed_time.s}@${body.result.confidence}`,
  };
}

// Keep the Reading domain type referenced to document the relationship
// — a verified row is a normal Reading with `verified=true`. A later
// refactor could switch to returning that shape directly.
export type { Reading };
