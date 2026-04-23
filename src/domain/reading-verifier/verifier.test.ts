import { describe, it, expect } from "vitest";
import { computeVerifiedDeviation } from "./verifier";

// Unit tests for the drift-computation helper. The broader verifier
// pipeline (R2 upload, DB insert, AI call) is covered by
// tests/integration/readings.verified.test.ts — this file is only the
// minute-boundary math.

function tsFromHms(hh: number, mm: number, ss: number): number {
  // Anchor to an arbitrary UTC day so the math is hermetic to the
  // runner's local TZ. `computeVerifiedDeviation` uses UTC getters
  // on the reference side, which matches.
  return Date.UTC(2024, 0, 15, hh, mm, ss);
}

describe("computeVerifiedDeviation", () => {
  it("dial ahead of reference by 2s → +2", () => {
    expect(
      computeVerifiedDeviation(
        { hours: 14, minutes: 32, seconds: 7 },
        tsFromHms(14, 32, 5),
      ),
    ).toBe(2);
  });

  it("dial behind reference by 3s → -3", () => {
    expect(
      computeVerifiedDeviation(
        { hours: 9, minutes: 15, seconds: 0 },
        tsFromHms(9, 15, 3),
      ),
    ).toBe(-3);
  });

  it("dial exactly matches → 0", () => {
    expect(
      computeVerifiedDeviation({ hours: 0, minutes: 0, seconds: 0 }, tsFromHms(0, 0, 0)),
    ).toBe(0);
  });

  it("minute boundary: dial=00:00:30, ref=23:59:55 → +35s (not +35m)", () => {
    // Dial rolled over just before the reference's last tick.
    // Raw time-of-day diff is huge negative; wrap yields +35.
    expect(
      computeVerifiedDeviation(
        { hours: 0, minutes: 0, seconds: 30 },
        tsFromHms(23, 59, 55),
      ),
    ).toBe(35);
  });

  it("minute boundary: dial=23:59:55, ref=00:00:30 → -35s", () => {
    expect(
      computeVerifiedDeviation(
        { hours: 23, minutes: 59, seconds: 55 },
        tsFromHms(0, 0, 30),
      ),
    ).toBe(-35);
  });

  it("wraps diffs > +30 min to the negative side", () => {
    // Dial reads 15:30:00, ref is 14:00:00 → raw +1h30m.
    // [-1800, 1800] wrap brings this to -1800 (the boundary is
    // inclusive of the lower bound, exclusive of the upper).
    expect(
      computeVerifiedDeviation(
        { hours: 15, minutes: 30, seconds: 0 },
        tsFromHms(14, 0, 0),
      ),
    ).toBe(-1800);
  });

  it("never returns NaN, even with weird inputs", () => {
    const result = computeVerifiedDeviation(
      { hours: 0, minutes: 0, seconds: 0 },
      tsFromHms(12, 0, 0),
    );
    expect(Number.isFinite(result)).toBe(true);
  });
});
