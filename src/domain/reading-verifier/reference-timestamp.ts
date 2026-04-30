// Reference-timestamp resolver shared by:
//
//   * the verified-reading flow in `verifier.ts`
//   * the manual-with-photo fallback added in slice #80 (issue
//     #80, PRD #73 User Story #10)
//
// Trust contract — precedence order, first match wins:
//
//   1. **clientCaptureMs** (PR #124, fix for the upload-latency bias
//      bug, see verifier.test.ts comment). The SPA's canvas-based
//      resize step strips EXIF, so the byte-EXIF path almost always
//      falls through to server arrival in production; server arrival
//      lags photo capture by 5-15 s of upload latency, which biases
//      every verified reading by that amount. The SPA fixes this by
//      reading EXIF DateTimeOriginal from the ORIGINAL bytes before
//      resizing, falling back to `Date.now()` at file selection,
//      and sending the result as a multipart `client_capture_ms`
//      field. Bounded against server arrival like byte-EXIF — same
//      anti-cheat ceiling.
//   2. **byte-EXIF DateTimeOriginal** — surviving fallback for the
//      handful of code paths that send raw camera bytes (the manual-
//      with-photo flow when implemented; tests). In production the
//      verified-reading SPA always sends bytes that have been
//      canvas-stripped, so this branch effectively never fires for
//      that flow. Kept for defense-in-depth + the manual flow.
//   3. **serverArrivalMs** — last resort. Already biased by upload
//      latency, but always available.
//
// Pulling this out of `verifier.ts` keeps the bounds + the
// resolution policy in one place, so adding a third caller (or
// changing the bounds) is a single-file edit. The verifier still
// drives the dial-reader pipeline and the deviation calc; this
// module is just the timestamp gate.

import { extractCaptureTimestampMs } from "./exif";

/**
 * Maximum tolerated past delta vs server arrival. 5 minutes covers
 * realistic mobile upload latency + small phone-clock-behind-server
 * skew. Anything older is rejected as `exif_clock_skew` (the error
 * code is named for the EXIF case but applies to any out-of-bounds
 * client-supplied timestamp — kept under one wire-format name for
 * SPA error-mapping simplicity).
 */
export const EXIF_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Maximum tolerated future delta vs server arrival. 1 minute is
 * enough for small NTP skew; beyond that the timestamp is almost
 * certainly a misset clock or a spoof attempt.
 */
export const EXIF_MAX_FUTURE_MS = 1 * 60 * 1000;

export type ReferenceSource = "exif" | "server" | "client";

export type ReferenceTimestampResult =
  | { ok: true; referenceTimestamp: number; source: ReferenceSource }
  | { ok: false; error: "exif_clock_skew"; deltaMs: number };

/**
 * Resolve a reference timestamp. The `serverArrivalMs` MUST be
 * captured at handler entry, BEFORE awaiting the multipart body —
 * otherwise upload latency leaks into the reference and creates
 * phantom drift on the resulting reading. See the comment in
 * `src/server/routes/readings.ts` for the same constraint applied
 * to the verified-reading route.
 *
 * Never throws. EXIF parse failures collapse to "no EXIF" → next
 * fallback. An out-of-bounds EXIF or `clientCaptureMs` produces an
 * error; if BOTH are out-of-bounds, the client signal wins (the
 * caller chose to send it, so we surface its error rather than
 * silently downgrading to the byte-EXIF reading).
 */
export async function resolveReferenceTimestamp(
  imageBuffer: ArrayBuffer,
  serverArrivalMs: number,
  clientCaptureMs?: number,
): Promise<ReferenceTimestampResult> {
  // Precedence #1: client-supplied capture time.
  if (clientCaptureMs !== undefined) {
    const skew = checkBounds(clientCaptureMs, serverArrivalMs);
    if (skew !== null) return skew;
    return { ok: true, referenceTimestamp: clientCaptureMs, source: "client" };
  }
  // Precedence #2: EXIF DateTimeOriginal from photo bytes.
  const exifMs = await extractCaptureTimestampMs(imageBuffer);
  if (exifMs === null) {
    // Precedence #3: server arrival.
    return { ok: true, referenceTimestamp: serverArrivalMs, source: "server" };
  }
  const skew = checkBounds(exifMs, serverArrivalMs);
  if (skew !== null) return skew;
  return { ok: true, referenceTimestamp: exifMs, source: "exif" };
}

/**
 * Bounds check for a candidate reference timestamp. Returns null
 * when in-bounds; an error result when out-of-bounds. Pulled out
 * so the EXIF and client paths apply identical bounds without
 * duplicating the comparison logic.
 */
function checkBounds(
  candidateMs: number,
  serverArrivalMs: number,
): { ok: false; error: "exif_clock_skew"; deltaMs: number } | null {
  const delta = candidateMs - serverArrivalMs;
  if (delta < -EXIF_MAX_AGE_MS) {
    return { ok: false, error: "exif_clock_skew", deltaMs: delta };
  }
  if (delta > EXIF_MAX_FUTURE_MS) {
    return { ok: false, error: "exif_clock_skew", deltaMs: delta };
  }
  return null;
}
