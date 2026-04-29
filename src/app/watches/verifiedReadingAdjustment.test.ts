// Unit tests for the SPA confirmation-page math helpers.
//
// These are pure functions — no DOM, no fetch — so they run cleanly
// inside the cloudflare-workers vitest pool alongside the rest of
// the workers-pool tests.

import { describe, expect, it } from "vitest";
import {
  ADJUSTMENT_LIMIT_SECONDS,
  adjustSeconds,
  canAdjust,
  clicksUsed,
  formatMmSs,
  mmSsCircularDistance,
} from "./verifiedReadingAdjustment";

describe("adjustSeconds", () => {
  it("increments seconds within the same minute", () => {
    expect(adjustSeconds({ m: 19, s: 34 }, 1)).toEqual({ m: 19, s: 35 });
    expect(adjustSeconds({ m: 19, s: 34 }, 5)).toEqual({ m: 19, s: 39 });
  });

  it("decrements seconds within the same minute", () => {
    expect(adjustSeconds({ m: 19, s: 34 }, -1)).toEqual({ m: 19, s: 33 });
    expect(adjustSeconds({ m: 19, s: 34 }, -10)).toEqual({ m: 19, s: 24 });
  });

  it("wraps forward across the minute boundary", () => {
    // The dial doesn't clamp at 59 — going +1 from 59s lands at the
    // next minute's 0s. Critical: clamping would leak "you've hit
    // the wall" as a deviation hint.
    expect(adjustSeconds({ m: 19, s: 59 }, 1)).toEqual({ m: 20, s: 0 });
    expect(adjustSeconds({ m: 19, s: 58 }, 5)).toEqual({ m: 20, s: 3 });
  });

  it("wraps backward across the minute boundary", () => {
    expect(adjustSeconds({ m: 20, s: 0 }, -1)).toEqual({ m: 19, s: 59 });
    expect(adjustSeconds({ m: 20, s: 2 }, -5)).toEqual({ m: 19, s: 57 });
  });

  it("wraps across the 60-minute boundary (total seconds modulo 3600)", () => {
    // Theoretical edge case. The product flow uses ±30s so this
    // shouldn't fire in practice, but the helper handles it.
    expect(adjustSeconds({ m: 59, s: 59 }, 1)).toEqual({ m: 0, s: 0 });
    expect(adjustSeconds({ m: 0, s: 0 }, -1)).toEqual({ m: 59, s: 59 });
  });
});

describe("mmSsCircularDistance", () => {
  it("is zero for identical pairs", () => {
    expect(mmSsCircularDistance({ m: 19, s: 34 }, { m: 19, s: 34 })).toBe(0);
  });

  it("returns the signed shortest distance for nearby pairs", () => {
    expect(mmSsCircularDistance({ m: 19, s: 35 }, { m: 19, s: 34 })).toBe(1);
    expect(mmSsCircularDistance({ m: 19, s: 33 }, { m: 19, s: 34 })).toBe(-1);
  });

  it("wraps through the 60-minute boundary", () => {
    // 0m 0s is 1s after 59m 59s on the circle, not 3599s before.
    expect(mmSsCircularDistance({ m: 0, s: 0 }, { m: 59, s: 59 })).toBe(1);
    expect(mmSsCircularDistance({ m: 59, s: 59 }, { m: 0, s: 0 })).toBe(-1);
  });
});

describe("clicksUsed", () => {
  it("is zero when the user has not adjusted", () => {
    expect(clicksUsed({ m: 19, s: 34 }, { m: 19, s: 34 })).toBe(0);
  });

  it("counts absolute seconds nudged in either direction", () => {
    expect(clicksUsed({ m: 19, s: 34 }, { m: 19, s: 39 })).toBe(5);
    expect(clicksUsed({ m: 19, s: 34 }, { m: 19, s: 29 })).toBe(5);
  });

  it("counts wrap-aware distance when seconds cross the minute", () => {
    // Predicted at 19:58, current at 20:01 — the user nudged +3.
    expect(clicksUsed({ m: 19, s: 58 }, { m: 20, s: 1 })).toBe(3);
  });
});

describe("canAdjust", () => {
  it("allows + when under the cap", () => {
    expect(canAdjust({ m: 19, s: 34 }, { m: 19, s: 34 }, 1)).toBe(true);
    expect(canAdjust({ m: 19, s: 34 }, { m: 20, s: 3 }, 1)).toBe(true); // 29 used
  });

  it("disables + at exactly +30", () => {
    // Predicted 19:34, current 20:04 → 30s used. Clicking + would
    // take it to 20:05 (31s used) which is over the cap.
    expect(canAdjust({ m: 19, s: 34 }, { m: 20, s: 4 }, 1)).toBe(false);
  });

  it("still allows − when at the +30 limit", () => {
    expect(canAdjust({ m: 19, s: 34 }, { m: 20, s: 4 }, -1)).toBe(true);
  });

  it("disables − at exactly -30 (mirror of +30 case)", () => {
    expect(canAdjust({ m: 19, s: 34 }, { m: 19, s: 4 }, -1)).toBe(false);
    expect(canAdjust({ m: 19, s: 34 }, { m: 19, s: 4 }, 1)).toBe(true);
  });

  it("ADJUSTMENT_LIMIT_SECONDS is 30 (mirrors server)", () => {
    expect(ADJUSTMENT_LIMIT_SECONDS).toBe(30);
  });
});

describe("formatMmSs", () => {
  it("zero-pads minutes and seconds", () => {
    expect(formatMmSs({ m: 0, s: 0 })).toBe("00:00");
    expect(formatMmSs({ m: 19, s: 34 })).toBe("19:34");
    expect(formatMmSs({ m: 5, s: 9 })).toBe("05:09");
  });
});
