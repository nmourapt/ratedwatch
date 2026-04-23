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
//   * 503 + error: "verified_readings_disabled" → feature flag off for this user
//   * 400 + error: "image_required"      → form didn't include the file (client bug)
//   * 413 + error: "image_too_large"     → image > 10 MB
//   * 401/403/404/500                    → generic
//
// Every unmapped case falls back to a single "something went wrong"
// line so we never leak raw status codes into the UI.

export type VerifiedReadingErrorCode =
  | "ai_refused"
  | "ai_unparseable"
  | "ai_implausible"
  | "verified_readings_disabled"
  | "image_required"
  | "image_too_large"
  | "unknown";

export interface VerifiedReadingErrorMessage {
  code: VerifiedReadingErrorCode;
  message: string;
}

const GENERIC: VerifiedReadingErrorMessage = {
  code: "unknown",
  message: "Something went wrong — try again",
};

export function mapVerifiedReadingError(
  status: number,
  serverCode?: string,
): VerifiedReadingErrorMessage {
  if (status === 503 && serverCode === "verified_readings_disabled") {
    return {
      code: "verified_readings_disabled",
      message: "Verified readings aren't enabled for your account yet",
    };
  }

  if (status === 422) {
    if (serverCode === "ai_refused") {
      return {
        code: "ai_refused",
        message: "We couldn't read the dial in your photo — try a clearer shot",
      };
    }
    if (serverCode === "ai_unparseable") {
      return {
        code: "ai_unparseable",
        message: "The AI returned an unexpected response — try again",
      };
    }
    if (serverCode === "ai_implausible") {
      return {
        code: "ai_implausible",
        message: "The reading looked off (bad lighting or dirty glass?) — try again",
      };
    }
  }

  if (status === 413 && serverCode === "image_too_large") {
    return {
      code: "image_too_large",
      message: "Image is too large — the maximum is 10 MB",
    };
  }

  if (status === 400 && serverCode === "image_required") {
    return {
      code: "image_required",
      message: "Please choose a photo first",
    };
  }

  return GENERIC;
}
