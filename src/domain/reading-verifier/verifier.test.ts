import { describe, it, expect } from "vitest";
import { computeVerifiedDeviation } from "./verifier";

// Unit tests for the MM:SS drift-computation helper. The broader
// verifier pipeline (R2 upload, DB insert, AI call) is covered by
// tests/integration/readings.verified.test.ts — this file is only
// the minute-boundary math.
//
// Contract: the dial reader returns `{ minutes, seconds }` (0-59
// each). The verifier wraps (dialMin*60 + dialSec) - (refMin*60 +
// refSec) into [-1800, +1800] seconds — a ±30 minute window. Any
// drift > 30 minutes in absolute value wraps (documented constraint;
// realistic mechanical drift never approaches that).

function tsFromHms(hh: number, mm: number, ss: number): number {
  // Anchor to an arbitrary UTC day so the math is hermetic to the
  // runner's local TZ. `computeVerifiedDeviation` derives MM:SS
  // from the ms timestamp via UTC getters, which is TZ-independent.
  return Date.UTC(2024, 0, 15, hh, mm, ss);
}

describe("computeVerifiedDeviation", () => {
  it("dial ahead of reference by 2s → +2", () => {
    expect(
      computeVerifiedDeviation({ minutes: 32, seconds: 7 }, tsFromHms(14, 32, 5)),
    ).toBe(2);
  });

  it("dial behind reference by 3s → -3", () => {
    expect(
      computeVerifiedDeviation({ minutes: 15, seconds: 0 }, tsFromHms(9, 15, 3)),
    ).toBe(-3);
  });

  it("dial ahead by a full minute + 5s → +65s", () => {
    // Dial shows 33:10 while reference reads 32:05 — watch is 65s
    // ahead. Seconds-only contract would have lost the minute.
    expect(
      computeVerifiedDeviation({ minutes: 33, seconds: 10 }, tsFromHms(14, 32, 5)),
    ).toBe(65);
  });

  it("dial behind by a full minute + 5s → -65s", () => {
    // Dial 31:00, reference 32:05 — watch is 65s behind.
    expect(
      computeVerifiedDeviation({ minutes: 31, seconds: 0 }, tsFromHms(14, 32, 5)),
    ).toBe(-65);
  });

  it("dial exactly matches → 0", () => {
    expect(computeVerifiedDeviation({ minutes: 0, seconds: 0 }, tsFromHms(0, 0, 0))).toBe(
      0,
    );
    expect(
      computeVerifiedDeviation({ minutes: 34, seconds: 30 }, tsFromHms(12, 34, 30)),
    ).toBe(0);
    expect(
      computeVerifiedDeviation({ minutes: 8, seconds: 59 }, tsFromHms(8, 8, 59)),
    ).toBe(0);
  });

  it("minute boundary: dial=0:02, ref=59:58 → +4s (not -3596s)", () => {
    // Dial has just rolled over the hour-boundary ahead of the
    // reference clock; raw diff is -3596; wrap yields +4.
    expect(
      computeVerifiedDeviation({ minutes: 0, seconds: 2 }, tsFromHms(23, 59, 58)),
    ).toBe(4);
  });

  it("minute boundary: dial=59:58, ref=0:02 → -4s", () => {
    // Reference has rolled over; dial is 4s behind.
    expect(
      computeVerifiedDeviation({ minutes: 59, seconds: 58 }, tsFromHms(0, 0, 2)),
    ).toBe(-4);
  });

  it("wraps true drifts > +30 minutes into the negative half", () => {
    // Dial 45:00, ref 0:00 → raw +2700s → wrap to -900s (-15 min).
    expect(
      computeVerifiedDeviation({ minutes: 45, seconds: 0 }, tsFromHms(14, 0, 0)),
    ).toBe(-900);
  });

  it("wraps true drifts < -30 minutes into the positive half", () => {
    // Dial 0:00, ref 45:00 → raw -2700s → wrap to +900s (+15 min).
    expect(
      computeVerifiedDeviation({ minutes: 0, seconds: 0 }, tsFromHms(14, 45, 0)),
    ).toBe(900);
  });

  it("handles drifts right at ±30 minutes deterministically", () => {
    // The wrap interval puts the half-period on a single side — we
    // don't care which, as long as it's deterministic.
    const result = computeVerifiedDeviation(
      { minutes: 30, seconds: 0 },
      tsFromHms(14, 0, 0),
    );
    expect(Math.abs(result)).toBe(1800);
  });

  it("never returns NaN, even with weird inputs", () => {
    const result = computeVerifiedDeviation(
      { minutes: 0, seconds: 0 },
      tsFromHms(12, 0, 0),
    );
    expect(Number.isFinite(result)).toBe(true);
  });

  it("tolerates out-of-range dial minutes/seconds without exploding", () => {
    // The reader shouldn't emit these (it validates 0-59 on each
    // field), but the helper shouldn't NaN/Infinity if it ever sees
    // one. The exact value isn't the contract — "finite, in
    // [-1800, +1800]" is.
    for (const mm of [-1, 0, 61]) {
      for (const ss of [-1, 0, 61]) {
        const result = computeVerifiedDeviation(
          { minutes: mm, seconds: ss },
          tsFromHms(0, 0, 0),
        );
        expect(Number.isFinite(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(-1800);
        expect(result).toBeLessThanOrEqual(1800);
      }
    }
  });
});
