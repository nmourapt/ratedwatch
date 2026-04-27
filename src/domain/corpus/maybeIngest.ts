// Corpus collection — slice #81 of PRD #73.
//
// When a verified-reading attempt either rejects or succeeds with a
// low-margin confidence (< 0.85), and the user opted in via
// `consent_corpus = 1`, copy the photo into a dedicated R2 bucket
// (`rated-watch-corpus`) accompanied by an anonymized JSON sidecar.
// High-confidence successes are NOT ingested — they're already known
// signals, not informative for tuning the pipeline.
//
// Anonymization is enforced by the function signature: this module
// never accepts user_id, watch_id, or any timestamp that could
// correlate to a specific user (the sidecar's `created_at` is the
// ingest moment, not the watch's reading reference timestamp). The
// only identifier that flows in is `reading_id`, which is itself an
// opaque UUID with no embedded user information. Retroactive
// deletion (consent_corpus 1→0) is handled separately by the
// `PATCH /api/v1/me` route, which enumerates the user's reading IDs
// from D1 and deletes the corresponding corpus objects.
//
// Object layout:
//   corpus/{YYYY-MM-DD}/{reading_id}/photo.{ext}
//   corpus/{YYYY-MM-DD}/{reading_id}/sidecar.json
//
// `{YYYY-MM-DD}` is the UTC date of the ingest moment, NOT the
// reading's reference timestamp — this is part of the anonymization
// guarantee (a user's reading at 03:00 in their local time doesn't
// land in a separately-bucketed UTC date that could be used to
// correlate with their location).
//
// Errors are deliberately swallowed: corpus collection is opportunistic
// and any failure here MUST NOT propagate to the user-facing response
// (the verified-reading reading itself is canonical and must not be
// rolled back by an R2 hiccup on the corpus side). Callers wrap this
// in `c.executionCtx.waitUntil(...)` so the latency is fully off the
// request path.

/**
 * Threshold above which a successful verified-reading is NOT ingested
 * into the corpus — the dial reader is confident enough that we
 * already have the signal we'd want from this image. Reads below this
 * (and any rejection) are the informative ones for tuning.
 *
 * Exported so tests + the integration harness can reference the same
 * constant rather than hard-coding 0.85 in multiple places.
 */
export const CORPUS_HIGH_CONFIDENCE_THRESHOLD = 0.85;

/**
 * Inputs accepted by `maybeIngest`. Note the absence of any
 * user-identifying field — anonymization is enforced at the type
 * level. Callers pass only what's needed to:
 *   - decide whether to ingest (`consentCorpus`, `verified`,
 *     `confidence`)
 *   - place the object (`readingId`, `imageContentType`)
 *   - describe the object (everything else)
 */
export interface MaybeIngestInput {
  readingId: string;
  photoBytes: Uint8Array;
  imageContentType: string;
  consentCorpus: boolean;
  verified: boolean;
  confidence: number | null;
  rejectionReason: string | null;
  dialReaderVersion: string | null;
  env: { R2_CORPUS: R2Bucket };
}

/**
 * Map an HTTP-style content-type to a short file extension. Any
 * unrecognised type falls back to `bin` so the object key always has
 * an extension (operator scripts list-by-prefix on it). Kept narrow
 * to the formats the verified-reading pipeline accepts (JPEG, PNG,
 * WebP, HEIC, HEIF) plus a defensive fallback.
 */
function extensionFor(contentType: string): string {
  const normalised = contentType.toLowerCase().split(";")[0]!.trim();
  switch (normalised) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    default:
      return "bin";
  }
}

/**
 * Format a `Date` as `YYYY-MM-DD` in UTC. We deliberately use UTC,
 * not the user's local date, so the date prefix in the object key
 * doesn't leak the user's timezone via batched-by-day grouping.
 */
function utcDateString(now: Date): string {
  const y = now.getUTCFullYear().toString().padStart(4, "0");
  const m = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = now.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Decide whether the inputs warrant a corpus write, and if so, copy
 * the photo + emit the anonymized sidecar to the corpus bucket.
 *
 * Gate logic:
 *   1. `consentCorpus === false`  → no-op (privacy-preserving default).
 *   2. `verified === true && confidence !== null && confidence >= 0.85`
 *      → no-op (high-confidence successes are not informative).
 *   3. Otherwise → write photo + sidecar to the corpus bucket.
 *
 * Errors are caught and logged at warn-level. The function never
 * throws, so callers can fire-and-forget via `waitUntil` without
 * defensive try/catch wrapping.
 */
export async function maybeIngest(input: MaybeIngestInput): Promise<void> {
  const {
    readingId,
    photoBytes,
    imageContentType,
    consentCorpus,
    verified,
    confidence,
    rejectionReason,
    dialReaderVersion,
    env,
  } = input;

  // Gate 1: no consent → nothing happens.
  if (consentCorpus === false) {
    return;
  }

  // Gate 2: high-confidence success → not informative for the corpus.
  // We require `confidence !== null` here so a missing-confidence
  // success (legacy AI path, hypothetical future un-scored backends)
  // doesn't fall into the "skip" branch — without a score we can't
  // claim it's high-confidence.
  if (
    verified === true &&
    confidence !== null &&
    confidence >= CORPUS_HIGH_CONFIDENCE_THRESHOLD
  ) {
    return;
  }

  // Below this point: we're ingesting. Build the object keys + the
  // sidecar JSON, then push both to R2. Any error is swallowed —
  // see the module-level rationale.
  try {
    const ingestMoment = new Date();
    const dateStr = utcDateString(ingestMoment);
    const ext = extensionFor(imageContentType);

    const photoKey = `corpus/${dateStr}/${readingId}/photo.${ext}`;
    const sidecarKey = `corpus/${dateStr}/${readingId}/sidecar.json`;

    // Anonymized sidecar. CRITICAL: no user_id, watch_id, email,
    // username, or any reading reference timestamp. The only
    // operator-useful identifier is `reading_id` (a UUID), which is
    // also the foreign key the retroactive-deletion path uses. The
    // shape is documented in the slice #81 issue body — keep them
    // aligned if you change anything here.
    const sidecarBody = {
      reading_id: readingId,
      created_at: ingestMoment.toISOString(),
      dial_reader_version: dialReaderVersion,
      confidence,
      verified,
      rejection_reason: rejectionReason,
      image_format: imageContentType,
      image_bytes: photoBytes.length,
    };

    // Photo: copy bytes into the corpus bucket. We slice() to detach
    // the buffer from the caller's array (the caller may reuse the
    // backing memory). The R2 SDK accepts ArrayBuffer / Uint8Array
    // directly; a fresh ArrayBuffer is the most-portable shape.
    await env.R2_CORPUS.put(photoKey, photoBytes.slice().buffer, {
      httpMetadata: { contentType: imageContentType },
    });

    // Sidecar: stringified JSON with a `application/json` content
    // type so an operator browsing the bucket gets pretty rendering
    // by default.
    await env.R2_CORPUS.put(sidecarKey, JSON.stringify(sidecarBody, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (err) {
    // Best-effort. The verified-reading reading itself is canonical
    // (already in D1 with a verified=1 row); a failed corpus write
    // does NOT roll the reading back. Operator tail catches
    // systemic failures via this warn.
    console.warn(
      `corpus.maybeIngest: write failed for reading ${readingId}, swallowing:`,
      err,
    );
  }
}
