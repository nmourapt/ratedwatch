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
    const mapped = mapVerifiedReadingError(422, "ai_refused");
    expect(mapped.message).toMatch(/couldn't read the dial/i);
    expect(mapped.manualFallback).toBe(false);
    expect(mapped.canRetake).toBe(true);
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

  // CV-pipeline error vocabulary (PRD #73 User Stories #7-#11). The
  // copy is verbatim from the issue body so QA can grep for drift.
  it("maps dial_reader_unsupported_dial (422) with manualFallback=true", () => {
    const mapped = mapVerifiedReadingError(422, "dial_reader_unsupported_dial");
    expect(mapped.code).toBe("dial_reader_unsupported_dial");
    expect(mapped.message).toMatch(/isn't supported by verified-reading yet/i);
    expect(mapped.message).toMatch(/log this reading manually/i);
    expect(mapped.manualFallback).toBe(true);
    expect(mapped.canRetake).toBe(true);
    expect(mapped.canRetry).toBe(false);
  });

  it("maps dial_reader_low_confidence (422) with manualFallback=true", () => {
    const mapped = mapVerifiedReadingError(422, "dial_reader_low_confidence");
    expect(mapped.code).toBe("dial_reader_low_confidence");
    expect(mapped.message).toMatch(/sharper photo/i);
    expect(mapped.message).toMatch(/direct lighting/i);
    expect(mapped.manualFallback).toBe(true);
    expect(mapped.canRetake).toBe(true);
  });

  it("maps dial_reader_no_dial_found (422) with manualFallback=false", () => {
    const mapped = mapVerifiedReadingError(422, "dial_reader_no_dial_found");
    expect(mapped.code).toBe("dial_reader_no_dial_found");
    expect(mapped.message).toMatch(/centered and well-lit/i);
    // Issue is photo quality, not watch type — retake only.
    expect(mapped.manualFallback).toBe(false);
    expect(mapped.canRetake).toBe(true);
  });

  it("maps dial_reader_malformed_image (400) with retake-only", () => {
    const mapped = mapVerifiedReadingError(400, "dial_reader_malformed_image");
    expect(mapped.code).toBe("dial_reader_malformed_image");
    expect(mapped.message).toMatch(/please retake/i);
    expect(mapped.manualFallback).toBe(false);
    expect(mapped.canRetake).toBe(true);
  });

  it("maps dial_reader_transport_error (502) with canRetry=true and no manual", () => {
    const mapped = mapVerifiedReadingError(502, "dial_reader_transport_error");
    expect(mapped.code).toBe("dial_reader_transport_error");
    expect(mapped.message).toMatch(/connection failed/i);
    expect(mapped.canRetry).toBe(true);
    expect(mapped.canRetake).toBe(false);
    expect(mapped.manualFallback).toBe(false);
  });

  // Slice #5 of PRD #99 (issue #104) — median-of-3 + anchor-guard
  // rejections.

  it("maps dial_reader_anchor_disagreement (422) to a retake hint mentioning the phone clock", () => {
    const mapped = mapVerifiedReadingError(422, "dial_reader_anchor_disagreement");
    expect(mapped.code).toBe("dial_reader_anchor_disagreement");
    expect(mapped.message).toMatch(/clock|reconcile/i);
    expect(mapped.message).toMatch(/retake/i);
    expect(mapped.canRetake).toBe(true);
    expect(mapped.canRetry).toBe(false);
    expect(mapped.manualFallback).toBe(false);
  });

  it("maps dial_reader_anchor_echo_flagged (422) to a neutral retake hint (does not leak cheat detection)", () => {
    const mapped = mapVerifiedReadingError(422, "dial_reader_anchor_echo_flagged");
    expect(mapped.code).toBe("dial_reader_anchor_echo_flagged");
    expect(mapped.message).toMatch(/inconclusive|retake/i);
    // Don't expose internal cheat-detection vocabulary.
    expect(mapped.message).not.toMatch(/cheat|echo|suspicious/i);
    expect(mapped.canRetake).toBe(true);
    expect(mapped.canRetry).toBe(false);
    expect(mapped.manualFallback).toBe(false);
  });

  it("maps 429 to a daily-cap message with no retry/retake", () => {
    const mapped = mapVerifiedReadingError(429);
    expect(mapped.code).toBe("rate_limited");
    expect(mapped.message).toMatch(/daily verified-reading cap/i);
    expect(mapped.canRetry).toBe(false);
    expect(mapped.canRetake).toBe(false);
    expect(mapped.manualFallback).toBe(false);
  });
});
