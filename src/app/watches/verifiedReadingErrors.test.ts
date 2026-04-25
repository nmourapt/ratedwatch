// Tests for the error mapper used by VerifiedReadingCapture. The server
// returns a small enum of error codes for the /readings/verified
// endpoint; we map them to user-facing copy here and unit-test the
// mapping in isolation so the React component stays dumb.
//
// The mapping is the single place where backend error vocabulary
// crosses into the UI — if the wording drifts on either side, the
// tests here and the integration tests in slice #16 pin both ends.

import { describe, expect, it } from "vitest";
import { mapVerifiedReadingError } from "./verifiedReadingErrors";

describe("mapVerifiedReadingError", () => {
  it("maps ai_refused (422) to a re-take hint", () => {
    expect(mapVerifiedReadingError(422, "ai_refused").message).toMatch(
      /couldn't read the dial/i,
    );
  });

  it("maps ai_unparseable (422) to a generic AI-response error", () => {
    expect(mapVerifiedReadingError(422, "ai_unparseable").message).toMatch(
      /unexpected response/i,
    );
  });

  it("maps ai_implausible (422) to a lighting/glass retry hint", () => {
    expect(mapVerifiedReadingError(422, "ai_implausible").message).toMatch(
      /reading looked off/i,
    );
  });

  it("maps exif_clock_skew (422) to a fix-your-phone-clock hint", () => {
    // EXIF timestamp outside the -5min/+1min window. The most likely
    // cause is the user's phone clock being wrong (manual override,
    // travel without auto-time, or a long-suspended device). The
    // copy nudges them to fix the clock and retake the photo.
    const mapped = mapVerifiedReadingError(422, "exif_clock_skew");
    expect(mapped.code).toBe("exif_clock_skew");
    expect(mapped.message).toMatch(/clock/i);
  });

  it("maps verified_readings_disabled (503) to an account-not-enabled copy", () => {
    const mapped = mapVerifiedReadingError(503, "verified_readings_disabled");
    expect(mapped.message).toMatch(/verified readings aren't enabled/i);
    expect(mapped.code).toBe("verified_readings_disabled");
  });

  it("maps image_required (400) to a choose-photo hint", () => {
    expect(mapVerifiedReadingError(400, "image_required").message).toMatch(
      /choose a photo/i,
    );
  });

  it("maps image_too_large (413) to a max-size hint", () => {
    expect(mapVerifiedReadingError(413, "image_too_large").message).toMatch(/10 MB/);
  });

  it("falls back to the generic copy for unmatched 4xx", () => {
    expect(mapVerifiedReadingError(401).message).toMatch(/something went wrong/i);
  });

  it("falls back to the generic copy for unmatched 5xx", () => {
    expect(mapVerifiedReadingError(500).message).toMatch(/something went wrong/i);
  });

  it("falls back to the generic copy when the server gives us an unknown code", () => {
    expect(mapVerifiedReadingError(422, "martian_invasion").message).toMatch(
      /something went wrong/i,
    );
  });
});
