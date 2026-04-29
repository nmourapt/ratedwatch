// Verified-reading error mapper.
//
// POST /api/v1/watches/:id/readings/verified (slice #16) returns a
// small enum of server-side errors. The SPA must render human copy,
// never raw JSON. Keeping this mapping here — not inside the component
// — means it's unit-testable without a DOM and gives a single point of
// truth if the wording changes.
//
// Known server codes (see src/server/routes/readings.ts):
//   * 422 + error: "ai_refused"          → AI wouldn't read the dial
//   * 422 + error: "ai_unparseable"      → AI response wasn't JSON we expected
//   * 422 + error: "ai_implausible"      → AI read a dial time too far off
//   * 422 + error: "exif_clock_skew"     → EXIF timestamp outside the
//                                          -5min/+1min window vs server
//                                          (phone clock is wrong)
//   * 503 + error: "verified_readings_disabled" → feature flag off for this user
//   * 400 + error: "image_required"      → form didn't include the file (client bug)
//   * 413 + error: "image_too_large"     → image > 10 MB
//   * 401/403/404/500                    → generic
//
// Slice #80 (PRD #73) added the CV-pipeline error vocabulary. The
// route now returns `{ error_code, ux_hint }` for these — distinct
// from the legacy `{ error, raw_response }` shape so we can tell
// them apart on the wire. We keep the mapper unified so the SPA has
// one entry point regardless of which backend produced the failure.
//
//   * 422 + error_code: "dial_reader_unsupported_dial"  → chrono / GMT / sub-dial
//   * 422 + error_code: "dial_reader_low_confidence"    → 3-hand but unreadable
//   * 422 + error_code: "dial_reader_no_dial_found"     → photo doesn't show a dial
//   * 400 + error_code: "dial_reader_malformed_image"   → bytes were garbage
//   * 502 + error_code: "dial_reader_transport_error"   → upstream ran/timed out
//   * 429                                               → daily verified-reading cap
//
// `manualFallback` indicates whether the SPA should offer the "Enter
// manually" button alongside "Retake photo" (PRD #73 User Stories
// #7-#11). We let the data drive the UI rather than mirroring this
// switch in the React component itself — keeps the rendering dumb.
//
// Every unmapped case falls back to a single "something went wrong"
// line so we never leak raw status codes into the UI.

export type VerifiedReadingErrorCode =
  | "ai_refused"
  | "ai_unparseable"
  | "ai_implausible"
  | "exif_clock_skew"
  | "verified_readings_disabled"
  | "image_required"
  | "image_too_large"
  | "dial_reader_unsupported_dial"
  | "dial_reader_low_confidence"
  | "dial_reader_no_dial_found"
  | "dial_reader_malformed_image"
  | "dial_reader_transport_error"
  | "dial_reader_anchor_disagreement"
  | "dial_reader_anchor_echo_flagged"
  | "rate_limited"
  | "unknown";

export interface VerifiedReadingErrorMessage {
  code: VerifiedReadingErrorCode;
  message: string;
  /**
   * Whether the SPA should offer a "log manually with photo"
   * button alongside the retake button. PRD #73 user-story copy:
   * unsupported_dial and low_confidence allow it, no_dial_found
   * does NOT (the issue is photo quality, not watch type), and
   * everything else uses retake-only.
   */
  manualFallback: boolean;
  /**
   * Whether retaking the photo is the appropriate primary recovery
   * action. False for terminal cases like rate_limited where retry
   * makes things worse.
   */
  canRetake: boolean;
  /**
   * Whether retrying the same photo without changes is sensible
   * (transport errors, where the bytes are fine but the upstream
   * was unavailable).
   */
  canRetry: boolean;
}

const GENERIC: VerifiedReadingErrorMessage = {
  code: "unknown",
  message: "Something went wrong — try again",
  manualFallback: false,
  canRetake: true,
  canRetry: false,
};

export function mapVerifiedReadingError(
  status: number,
  serverCode?: string,
): VerifiedReadingErrorMessage {
  if (status === 503 && serverCode === "verified_readings_disabled") {
    return {
      code: "verified_readings_disabled",
      message: "Verified readings aren't enabled for your account yet",
      manualFallback: false,
      canRetake: false,
      canRetry: false,
    };
  }

  // CV-pipeline rejections (PRD #73 User Stories #7-#11). Slice #75
  // introduced the structured `error_code` shape; the SPA picks
  // its UX path off the code, the message is rendered verbatim.
  if (status === 422 && serverCode === "dial_reader_unsupported_dial") {
    return {
      code: "dial_reader_unsupported_dial",
      message:
        "This watch type isn't supported by verified-reading yet. Please log this reading manually.",
      manualFallback: true,
      canRetake: true,
      canRetry: false,
    };
  }
  if (status === 422 && serverCode === "dial_reader_low_confidence") {
    return {
      code: "dial_reader_low_confidence",
      message:
        "We couldn't read this dial confidently. Try a sharper photo with direct lighting, or log manually.",
      manualFallback: true,
      canRetake: true,
      canRetry: false,
    };
  }
  if (status === 422 && serverCode === "dial_reader_no_dial_found") {
    return {
      code: "dial_reader_no_dial_found",
      message:
        "We couldn't find a watch dial in this photo. Make sure the dial is centered and well-lit.",
      // No manual fallback: the issue is photo quality, not watch
      // type. Per PRD #73 User Story #11 the user has to retake.
      manualFallback: false,
      canRetake: true,
      canRetry: false,
    };
  }
  if (status === 400 && serverCode === "dial_reader_malformed_image") {
    return {
      code: "dial_reader_malformed_image",
      message: "Your photo couldn't be processed. Please retake.",
      manualFallback: false,
      canRetake: true,
      canRetry: false,
    };
  }
  if (status === 502 && serverCode === "dial_reader_transport_error") {
    return {
      code: "dial_reader_transport_error",
      message: "Connection failed while reading dial. Please try again.",
      manualFallback: false,
      canRetake: false,
      canRetry: true,
    };
  }

  // Slice #5 of PRD #99 (issue #104) — median-of-3 + anchor-guard
  // rejections. These both render as 422s with a retake nudge. The
  // anchor-echo path deliberately uses neutral copy ("inconclusive
  // read") rather than telling the user "we caught the model
  // cheating" — that's an internal-only signal.
  if (status === 422 && serverCode === "dial_reader_anchor_disagreement") {
    return {
      code: "dial_reader_anchor_disagreement",
      message:
        "We couldn't reconcile the dial with your phone's clock. Please retake the photo.",
      manualFallback: false,
      canRetake: true,
      canRetry: false,
    };
  }
  if (status === 422 && serverCode === "dial_reader_anchor_echo_flagged") {
    return {
      code: "dial_reader_anchor_echo_flagged",
      message: "Inconclusive read — please retake the photo.",
      manualFallback: false,
      canRetake: true,
      canRetry: false,
    };
  }

  // Daily rate-limit cap. Slice #82 owns the actual limiting; the
  // mapper is wired up here so the UX is in place when the limit
  // lands.
  if (status === 429) {
    return {
      code: "rate_limited",
      message: "You've hit your daily verified-reading cap. Try again tomorrow.",
      manualFallback: false,
      canRetake: false,
      canRetry: false,
    };
  }

  if (status === 422) {
    if (serverCode === "ai_refused") {
      return {
        code: "ai_refused",
        message: "We couldn't read the dial in your photo — try a clearer shot",
        manualFallback: false,
        canRetake: true,
        canRetry: false,
      };
    }
    if (serverCode === "ai_unparseable") {
      return {
        code: "ai_unparseable",
        message: "The AI returned an unexpected response — try again",
        manualFallback: false,
        canRetake: true,
        canRetry: true,
      };
    }
    if (serverCode === "ai_implausible") {
      return {
        code: "ai_implausible",
        message: "The reading looked off (bad lighting or dirty glass?) — try again",
        manualFallback: false,
        canRetake: true,
        canRetry: false,
      };
    }
    if (serverCode === "exif_clock_skew") {
      return {
        code: "exif_clock_skew",
        message:
          "Your phone's clock seems to be off — please check your phone's date & time, then retake the photo",
        manualFallback: false,
        canRetake: true,
        canRetry: false,
      };
    }
  }

  if (status === 413 && serverCode === "image_too_large") {
    return {
      code: "image_too_large",
      message: "Image is too large — the maximum is 10 MB",
      manualFallback: false,
      canRetake: true,
      canRetry: false,
    };
  }

  if (status === 400 && serverCode === "image_required") {
    return {
      code: "image_required",
      message: "Please choose a photo first",
      manualFallback: false,
      canRetake: true,
      canRetry: false,
    };
  }

  return GENERIC;
}
