// Unit tests for the pure helpers exported by VerifiedReadingCapture.
//
// FULL-COMPONENT RTL tests aren't wired up in this repo yet — the
// vitest pool is the cloudflare-workers-pool, which runs everything
// inside workerd and has no DOM. Setting up a parallel browser-mode
// vitest project (happy-dom + a separate config) is in scope for a
// follow-up. For now we cover the testable seams:
//
//   * `validateManualTime` — pure function over the HH:MM:SS picker
//     strings, used by the manual-fallback flow.
//
// The error-mapping → button-rendering matrix is covered by
// `verifiedReadingErrors.test.ts`; the resize logic by
// `resizePhoto.test.ts`. End-to-end behaviour is covered by
// `tests/integration/readings.manual_with_photo.test.ts`. So the
// untested seam is the React state machine itself, which a follow-
// up RTL slice can pick up.

import { describe, expect, it } from "vitest";
import { validateManualTime } from "./VerifiedReadingCapture";

describe("validateManualTime", () => {
  it("accepts a valid HH:MM:SS triple", () => {
    expect(validateManualTime({ hh: "14", mm: "32", ss: "10" })).toEqual({
      hh: 14,
      mm: 32,
      ss: 10,
    });
  });

  it("accepts boundary values 00:00:00 and 23:59:59", () => {
    expect(validateManualTime({ hh: "0", mm: "0", ss: "0" })).toEqual({
      hh: 0,
      mm: 0,
      ss: 0,
    });
    expect(validateManualTime({ hh: "23", mm: "59", ss: "59" })).toEqual({
      hh: 23,
      mm: 59,
      ss: 59,
    });
  });

  it("rejects a non-integer hour", () => {
    expect(validateManualTime({ hh: "12.5", mm: "0", ss: "0" })).toEqual({
      error: "Hours must be 0–23",
    });
  });

  it("rejects an out-of-range hour", () => {
    expect(validateManualTime({ hh: "24", mm: "0", ss: "0" })).toEqual({
      error: "Hours must be 0–23",
    });
    expect(validateManualTime({ hh: "-1", mm: "0", ss: "0" })).toEqual({
      error: "Hours must be 0–23",
    });
  });

  it("rejects an out-of-range minute", () => {
    expect(validateManualTime({ hh: "12", mm: "60", ss: "0" })).toEqual({
      error: "Minutes must be 0–59",
    });
  });

  it("rejects an out-of-range second", () => {
    expect(validateManualTime({ hh: "12", mm: "30", ss: "60" })).toEqual({
      error: "Seconds must be 0–59",
    });
  });

  it("rejects empty / non-numeric input", () => {
    expect("error" in validateManualTime({ hh: "", mm: "0", ss: "0" })).toBe(true);
    expect("error" in validateManualTime({ hh: "ab", mm: "0", ss: "0" })).toBe(true);
  });
});
