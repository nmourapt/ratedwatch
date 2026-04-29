// Worker-side VLM dial reader — public types.
//
// Slice #3 of PRD #99 (issue #102). Replaces the decommissioned Python
// container reader with a single VLM call to GPT-5.2 via Cloudflare's
// AI Gateway (unified billing).
//
// This slice ships the bare minimum result shape: success, unparseable
// model output, and transport error. The two anchor-related variants
// (`anchor_disagreement`, `anchor_echo_suspicious`) are added in
// slice #5 once the median-of-3 + anchor-guard pipeline is in place.

/**
 * Outcome of a single `readDial` call.
 *
 * The kind discriminator means call-sites must exhaustively branch on
 * the result, which is the whole point — we don't want a `success` row
 * to silently leak `unparseable`-shaped data into the verified-reading
 * persistence layer.
 *
 *   * `success` — the model returned a parseable HH:MM:SS and we have
 *     a `{ m, s }` for the verifier. The hour is dropped: the server
 *     clock owns the hour because verified readings are always within
 *     a session whose hour is known from the EXIF anchor / server time.
 *   * `unparseable` — the model returned, but the response did not
 *     contain an HH:MM:SS-shaped substring. Caller should reject the
 *     reading with a "we couldn't read the dial — please retake" UX.
 *   * `transport_error` — the AI binding (or the underlying gateway)
 *     threw before producing a response. Caller should retry once or
 *     surface a generic "service unavailable" message.
 */
export type DialReadResult =
  | {
      kind: "success";
      mm_ss: { m: number; s: number };
      raw_response: string;
      tokens_in?: number;
      tokens_out?: number;
    }
  | {
      kind: "unparseable";
      raw_response: string;
    }
  | {
      kind: "transport_error";
      message: string;
    };

/**
 * EXIF anchor — the camera's DateTimeOriginal expressed as 12-hour
 * clock components. The reader does NOT echo the anchor as its
 * answer; it's there as a sanity check for hand-classification.
 */
export interface ExifAnchor {
  /** 1-12 (12-hour clock). */
  h: number;
  /** 0-59. */
  m: number;
  /** 0-59. */
  s: number;
}

/**
 * Inputs to {@link readDial}. The cropped image is the 768×768 dial
 * crop produced by the dial-cropper (slice #2); the reader does not
 * perform its own crop.
 */
export interface ReadDialInput {
  /** Pre-cropped 768×768 dial image, JPEG bytes. */
  croppedImage: ArrayBuffer;
  /** EXIF anchor (12-hour clock). */
  exifAnchor: ExifAnchor;
  /**
   * A correlation id propagated through structured logs and (later)
   * Analytics Engine events. Slice #3 keeps it on the input shape so
   * downstream slices can wire it up without touching the public
   * signature again.
   */
  runId: string;
}
