// Pure-function tests for the HH:MM:SS extractor.
//
// Lifted from `scripts/vlm-bakeoff/bakeoff.py::_parse_response_hms`,
// which is the canonical reference. The bake-off prompt asks the
// model for "ONLY HH:MM:SS" but real responses sometimes include
// surrounding prose ("Time: 10:19:34."), Markdown decoration, or
// blank/refused output. We tolerate the noise and reject obviously-
// invalid times.

import { describe, expect, it } from "vitest";
import { parseHmsResponse } from "./parse";

describe("parseHmsResponse", () => {
  it("parses a well-formed HH:MM:SS response", () => {
    expect(parseHmsResponse("10:19:34")).toEqual({ h: 10, m: 19, s: 34 });
  });

  it("parses surrounded by prose (single-digit hour rejected by anchor block… still ok here)", () => {
    expect(parseHmsResponse("Time: 10:19:34.")).toEqual({ h: 10, m: 19, s: 34 });
  });

  it("parses with a single-digit hour", () => {
    // The bake-off regex accepts H:MM:SS as well as HH:MM:SS so a
    // model that emits "9:05:01" is still valid.
    expect(parseHmsResponse("9:05:01")).toEqual({ h: 9, m: 5, s: 1 });
  });

  it("returns null for a malformed time (out-of-range minutes)", () => {
    expect(parseHmsResponse("25:99:99")).toBeNull();
  });

  it("returns null for a missing time", () => {
    expect(parseHmsResponse("none here")).toBeNull();
  });

  it("returns null for the empty string", () => {
    expect(parseHmsResponse("")).toBeNull();
  });

  it("returns null when the hour is 0 (12-hour clock starts at 1)", () => {
    // The bake-off regex enforces 1 <= h <= 12. "00:30:15" is therefore
    // rejected — a 12-hour clock face never displays 00, that's 12:00.
    expect(parseHmsResponse("00:30:15")).toBeNull();
  });

  it("returns null when the hour is 13 (12-hour clock tops out at 12)", () => {
    expect(parseHmsResponse("13:00:00")).toBeNull();
  });

  it("returns null when minutes exceed 59 (hour valid)", () => {
    // Exercises the m > 59 branch independently from the hour check.
    expect(parseHmsResponse("10:99:00")).toBeNull();
  });

  it("returns null when seconds exceed 59 (hour and minutes valid)", () => {
    // Exercises the s > 59 branch independently.
    expect(parseHmsResponse("10:30:99")).toBeNull();
  });

  it("picks the first match if the response contains multiple times", () => {
    // Defensive — chain-of-thought leaks sometimes echo intermediate
    // candidates. We trust the first match (matches the Python
    // reference's behaviour).
    expect(parseHmsResponse("Reasoning: 09:00:00. Final: 10:19:34.")).toEqual({
      h: 9,
      m: 0,
      s: 0,
    });
  });

  it("ignores non-time digit clusters that aren't H:MM:SS shaped", () => {
    expect(parseHmsResponse("123456 some 9876")).toBeNull();
  });
});
