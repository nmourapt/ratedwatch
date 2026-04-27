// Reference-timestamp resolver shared by:
//
//   * the verified-reading flow in `verifier.ts`
//   * the manual-with-photo fallback added in slice #80 (issue
//     #80, PRD #73 User Story #10)
//
// Both flows want the same trust contract: prefer EXIF
// DateTimeOriginal (the moment the shutter fired) when present and
// inside the bounds window vs server arrival, fall back to server
// arrival when EXIF is missing, reject when EXIF is present but
// outside the bounds.
//
// Pulling this out of `verifier.ts` keeps the bounds + the
// resolution policy in one place, so adding a third caller (or
// changing the bounds) is a single-file edit. The verifier still
// drives the dial-reader pipeline and the deviation calc; this
// module is just the timestamp gate.

import { extractCaptureTimestampMs } from "./exif";

/**
 * Maximum tolerated EXIF-in-the-past delta vs server arrival.
 * 5 minutes covers realistic mobile upload latency + small
 * phone-clock-behind-server skew. Anything older is rejected as
 * `exif_clock_skew`.
 */
export const EXIF_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Maximum tolerated EXIF-in-the-future delta vs server arrival.
 * 1 minute is enough for small NTP skew; beyond that the EXIF is
 * almost certainly a misset clock or a spoof attempt.
 */
export const EXIF_MAX_FUTURE_MS = 1 * 60 * 1000;

export type ReferenceTimestampResult =
  | { ok: true; referenceTimestamp: number; source: "exif" | "server" }
  | { ok: false; error: "exif_clock_skew"; deltaMs: number };

/**
 * Resolve a reference timestamp from an image buffer plus a
 * caller-captured server arrival time. The serverArrivalMs MUST be
 * captured at handler entry, BEFORE awaiting the multipart body —
 * otherwise upload latency leaks into the reference and creates
 * phantom drift on the resulting reading. See the comment in
 * `src/server/routes/readings.ts` for the same constraint applied
 * to the verified-reading route.
 *
 * Never throws. EXIF parse failures collapse to "no EXIF" → server
 * arrival; only an EXIF that successfully parses to an out-of-bounds
 * timestamp produces an error.
 */
export async function resolveReferenceTimestamp(
  imageBuffer: ArrayBuffer,
  serverArrivalMs: number,
): Promise<ReferenceTimestampResult> {
  const exifMs = await extractCaptureTimestampMs(imageBuffer);
  if (exifMs === null) {
    return { ok: true, referenceTimestamp: serverArrivalMs, source: "server" };
  }
  const delta = exifMs - serverArrivalMs;
  if (delta < -EXIF_MAX_AGE_MS) {
    return { ok: false, error: "exif_clock_skew", deltaMs: delta };
  }
  if (delta > EXIF_MAX_FUTURE_MS) {
    return { ok: false, error: "exif_clock_skew", deltaMs: delta };
  }
  return { ok: true, referenceTimestamp: exifMs, source: "exif" };
}
