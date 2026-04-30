// Unit tests for the SPA confirmation-page math helpers.
//
// These are pure functions — no DOM, no fetch — so they run cleanly
// inside the cloudflare-workers vitest pool alongside the rest of
// the workers-pool tests.
//
// PR #122 reworked the helpers from seconds-only ±30s nudges into
// per-component HH:MM:SS independent up/down. The old
// `adjustSeconds` / `clicksUsed` / `canAdjust` / `mmSsCircularDistance`
// surface area is gone; new tests cover `adjustComponent`,
// `formatHms`, and `parseHms`.

import { describe, expect, it } from "vitest";
import {
  adjustComponent,
  formatHms,
  parseHms,
  type Hms,
} from "./verifiedReadingAdjustment";

describe("adjustComponent — seconds slot", () => {
  it("increments seconds without touching minutes or hours", () => {
    expect(adjustComponent({ h: 10, m: 19, s: 34 }, "s", 1)).toEqual({
      h: 10,
      m: 19,
      s: 35,
    });
  });

  it("decrements seconds without touching minutes or hours", () => {
    expect(adjustComponent({ h: 10, m: 19, s: 34 }, "s", -1)).toEqual({
      h: 10,
      m: 19,
      s: 33,
    });
  });

  it("wraps seconds 59 -> 0 WITHOUT carrying into minutes", () => {
    // Critical: the watch crown analogy is "set each digit
    // independently". Carrying would surprise the user when they
    // wanted to fix a seconds misread without disturbing the minute.
    expect(adjustComponent({ h: 10, m: 19, s: 59 }, "s", 1)).toEqual({
      h: 10,
      m: 19,
      s: 0,
    });
  });

  it("wraps seconds 0 -> 59 WITHOUT carrying into minutes", () => {
    expect(adjustComponent({ h: 10, m: 19, s: 0 }, "s", -1)).toEqual({
      h: 10,
      m: 19,
      s: 59,
    });
  });

  it("handles large positive deltas with modulo", () => {
    expect(adjustComponent({ h: 10, m: 19, s: 30 }, "s", 65)).toEqual({
      h: 10,
      m: 19,
      s: (30 + 65) % 60, // 35
    });
  });

  it("handles large negative deltas with modulo", () => {
    expect(adjustComponent({ h: 10, m: 19, s: 5 }, "s", -65)).toEqual({
      h: 10,
      m: 19,
      s: (((5 - 65) % 60) + 60) % 60, // 0
    });
  });
});

describe("adjustComponent — minutes slot", () => {
  it("increments minutes without touching seconds or hours", () => {
    expect(adjustComponent({ h: 10, m: 19, s: 34 }, "m", 1)).toEqual({
      h: 10,
      m: 20,
      s: 34,
    });
  });

  it("decrements minutes without touching seconds or hours", () => {
    expect(adjustComponent({ h: 10, m: 19, s: 34 }, "m", -1)).toEqual({
      h: 10,
      m: 18,
      s: 34,
    });
  });

  it("wraps minutes 59 -> 0 WITHOUT carrying into hours", () => {
    expect(adjustComponent({ h: 10, m: 59, s: 34 }, "m", 1)).toEqual({
      h: 10,
      m: 0,
      s: 34,
    });
  });

  it("wraps minutes 0 -> 59 WITHOUT carrying into hours", () => {
    expect(adjustComponent({ h: 10, m: 0, s: 34 }, "m", -1)).toEqual({
      h: 10,
      m: 59,
      s: 34,
    });
  });
});

describe("adjustComponent — hours slot", () => {
  it("increments hours within 1..12", () => {
    expect(adjustComponent({ h: 10, m: 19, s: 34 }, "h", 1)).toEqual({
      h: 11,
      m: 19,
      s: 34,
    });
  });

  it("decrements hours within 1..12", () => {
    expect(adjustComponent({ h: 10, m: 19, s: 34 }, "h", -1)).toEqual({
      h: 9,
      m: 19,
      s: 34,
    });
  });

  it("wraps hours 12 -> 1 (12-hour analog cycle)", () => {
    expect(adjustComponent({ h: 12, m: 0, s: 0 }, "h", 1)).toEqual({
      h: 1,
      m: 0,
      s: 0,
    });
  });

  it("wraps hours 1 -> 12 (12-hour analog cycle)", () => {
    expect(adjustComponent({ h: 1, m: 0, s: 0 }, "h", -1)).toEqual({
      h: 12,
      m: 0,
      s: 0,
    });
  });

  it("handles a 12-step delta as identity", () => {
    expect(adjustComponent({ h: 10, m: 19, s: 34 }, "h", 12)).toEqual({
      h: 10,
      m: 19,
      s: 34,
    });
  });
});

describe("formatHms", () => {
  it("zero-pads each component to two digits", () => {
    expect(formatHms({ h: 1, m: 2, s: 3 })).toBe("01:02:03");
    expect(formatHms({ h: 12, m: 59, s: 59 })).toBe("12:59:59");
  });
});

describe("parseHms", () => {
  it("accepts a well-formed object", () => {
    const input = { h: 10, m: 19, s: 34 };
    expect(parseHms(input)).toEqual(input);
  });

  it("rejects out-of-range hours", () => {
    expect(parseHms({ h: 0, m: 0, s: 0 })).toBeNull();
    expect(parseHms({ h: 13, m: 0, s: 0 })).toBeNull();
    expect(parseHms({ h: -1, m: 0, s: 0 })).toBeNull();
  });

  it("rejects out-of-range minutes/seconds", () => {
    expect(parseHms({ h: 10, m: 60, s: 0 })).toBeNull();
    expect(parseHms({ h: 10, m: -1, s: 0 })).toBeNull();
    expect(parseHms({ h: 10, m: 0, s: 60 })).toBeNull();
    expect(parseHms({ h: 10, m: 0, s: -1 })).toBeNull();
  });

  it("rejects non-integers", () => {
    expect(parseHms({ h: 10.5, m: 0, s: 0 })).toBeNull();
    expect(parseHms({ h: NaN, m: 0, s: 0 })).toBeNull();
  });

  it("rejects non-objects + missing fields", () => {
    expect(parseHms(null)).toBeNull();
    expect(parseHms("10:19:34")).toBeNull();
    expect(parseHms({ m: 19, s: 34 })).toBeNull();
    expect(parseHms({ h: "10", m: 19, s: 34 })).toBeNull();
  });
});

// A tiny sanity check that the type is exported and usable.
describe("Hms type", () => {
  it("can be constructed from literals", () => {
    const x: Hms = { h: 10, m: 19, s: 34 };
    expect(x.h + x.m + x.s).toBe(63);
  });
});
