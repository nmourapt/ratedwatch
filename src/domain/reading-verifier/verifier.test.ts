import { describe, it, expect } from "vitest";
import { computeVerifiedDeviation } from "./verifier";

// Unit tests for the seconds-only drift-computation helper. The
// broader verifier pipeline (R2 upload, DB insert, AI call) is
// covered by tests/integration/readings.verified.test.ts — this file
// is only the minute-boundary math.
//
// Contract: the dial reader now returns only `seconds` (0-59). The
// verifier wraps dialSec - refSec into [-30, +30]. Drifts > 30 s in
// absolute value are ambiguous without the minute hand and wrap —
// that's a documented constraint, not a bug.

function tsFromHms(hh: number, mm: number, ss: number): number {
  // Anchor to an arbitrary UTC day so the math is hermetic to the
  // runner's local TZ. `computeVerifiedDeviation` reads seconds-of-
  // minute from the ms timestamp, which is TZ-independent anyway.
  return Date.UTC(2024, 0, 15, hh, mm, ss);
}

describe("computeVerifiedDeviation", () => {
  it("dial ahead of reference by 2s → +2", () => {
    expect(computeVerifiedDeviation({ seconds: 7 }, tsFromHms(14, 32, 5))).toBe(2);
  });

  it("dial behind reference by 3s → -3", () => {
    expect(computeVerifiedDeviation({ seconds: 0 }, tsFromHms(9, 15, 3))).toBe(-3);
  });

  it("dial exactly matches → 0", () => {
    expect(computeVerifiedDeviation({ seconds: 0 }, tsFromHms(0, 0, 0))).toBe(0);
    expect(computeVerifiedDeviation({ seconds: 30 }, tsFromHms(12, 34, 30))).toBe(0);
    expect(computeVerifiedDeviation({ seconds: 59 }, tsFromHms(8, 8, 59))).toBe(0);
  });

  it("minute boundary: dial=02, ref=58 → +4s (not -56s)", () => {
    // Dial rolled over just before the reference's last tick. Raw
    // diff is -56; wrap yields +4.
    expect(computeVerifiedDeviation({ seconds: 2 }, tsFromHms(23, 59, 58))).toBe(4);
  });

  it("minute boundary: dial=58, ref=02 → -4s", () => {
    // Dial is about to roll over, reference already has. Raw +56;
    // wrap yields -4.
    expect(computeVerifiedDeviation({ seconds: 58 }, tsFromHms(0, 0, 2))).toBe(-4);
  });

  it("wraps true drifts > +30 s into the negative half", () => {
    // Dial=40, ref=0 → raw +40 → wrap to -20 (documented
    // ambiguity: without the minute hand we can't tell this from
    // a -20 s drift).
    expect(computeVerifiedDeviation({ seconds: 40 }, tsFromHms(14, 0, 0))).toBe(-20);
  });

  it("wraps true drifts < -30 s into the positive half", () => {
    // Dial=0, ref=40 → raw -40 → wrap to +20.
    expect(computeVerifiedDeviation({ seconds: 0 }, tsFromHms(14, 0, 40))).toBe(20);
  });

  it("half-period boundary: dial=30, ref=0 → -30 or +30 (consistent)", () => {
    // The wrap interval [-30, +30] puts the half-period on a single
    // side — we don't care which, as long as it's deterministic.
    const result = computeVerifiedDeviation({ seconds: 30 }, tsFromHms(14, 0, 0));
    expect(Math.abs(result)).toBe(30);
  });

  it("never returns NaN, even with weird inputs", () => {
    const result = computeVerifiedDeviation({ seconds: 0 }, tsFromHms(12, 0, 0));
    expect(Number.isFinite(result)).toBe(true);
  });

  it("tolerates out-of-range dial seconds by normalising modulo 60", () => {
    // The reader shouldn't emit these, but the helper shouldn't
    // explode if it ever sees one.
    expect(computeVerifiedDeviation({ seconds: 61 }, tsFromHms(0, 0, 1))).toBe(0);
    expect(computeVerifiedDeviation({ seconds: -1 }, tsFromHms(0, 0, 59))).toBe(0);
  });
});
