// Worker-side VLM dial reader — public types.
//
// Slice #3 of PRD #99 (issue #102) introduced the single-call shape
// (`success | unparseable | transport_error`). Slice #5 (issue #104)
// rebuilds the reader as a parallel median-of-3 pipeline guarded by
// the anchor-disagreement check, and replaces the single `unparseable`
// variant with a more granular `rejection` variant that distinguishes:
//
//   * `anchor_disagreement`     — median MM:SS diverges > 60 s from
//                                 the EXIF anchor on the wrap-aware
//                                 MM:SS circle.
//   * `anchor_echo_suspicious`  — all 3 reads byte-identical to the
//                                 anchor (Claude-style cheat).
//   * `unparseable_majority`    — 2 of 3 (or 1 of 1) reads were
//                                 unparseable. The remaining read(s)
//                                 are not enough signal for a median.
//   * `all_runs_failed`         — all 3 reads were unparseable. The
//                                 model is fundamentally refusing to
//                                 emit HH:MM:SS for this image.
//
// The `transport_error` variant remains unchanged (network /
// gateway failures still surface as transport errors).

/**
 * Outcome of a `readDial` call (median-of-3).
 *
 * Call-sites must exhaustively branch on the `kind` discriminator;
 * we don't want a `success` row to silently leak rejection-shaped
 * data into the verified-reading persistence layer.
 *
 *   * `success` — the median MM:SS is trustworthy. `mm_ss` is the
 *     median; `raw_responses` is the array of all three model
 *     responses (kept for log/debug, never surfaced to users); token
 *     totals are summed across the three calls.
 *   * `rejection` — the median couldn't be trusted. `reason` tells
 *     the caller which specific check failed; `details.delta_seconds`
 *     is populated when `reason = "anchor_disagreement"` so the
 *     caller can log how far off we were.
 *   * `transport_error` — every parallel call threw before
 *     producing a response. Caller should retry once or surface a
 *     generic "service unavailable" message.
 */
export type DialReadResult =
  | {
      kind: "success";
      mm_ss: { m: number; s: number };
      raw_responses: string[];
      tokens_in_total?: number;
      tokens_out_total?: number;
    }
  | {
      kind: "rejection";
      reason:
        | "anchor_disagreement"
        | "all_runs_failed"
        | "unparseable_majority"
        | "anchor_echo_suspicious";
      details?: { delta_seconds?: number };
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
