// Unit tests for the progress-ring math helper used by the SPA
// dashboard + watch detail page.
//
// `readingsToBadge` answers "how many more verified readings does the
// owner need to earn the badge?" The UI shows the result as:
//
//   * "Verified watch" — when the badge is already earned.
//   * "X of Y verified — needs Z more to earn the badge" — when not.
//
// The math has to handle the awkward case where adding verified
// readings ALSO grows the denominator, so the formula can't just be
// `ceil(0.25*total) - verified`. See the docstring on the helper.

import { describe, expect, it } from "vitest";
import { readingsToBadge } from "./readings-to-badge";

describe("readingsToBadge()", () => {
  it("returns 0 when no readings exist yet (nothing to compute)", () => {
    expect(readingsToBadge(0, 0)).toEqual({ earned: false, needed: 0, ratio: 0 });
  });

  it("0 verified of 3 → needs 1 more verified reading (1/4 = 0.25)", () => {
    expect(readingsToBadge(0, 3)).toEqual({ earned: false, needed: 1, ratio: 0 });
  });

  it("0 verified of 1 → needs 1 more (1/2 = 0.5 ≥ 0.25)", () => {
    expect(readingsToBadge(0, 1)).toEqual({ earned: false, needed: 1, ratio: 0 });
  });

  it("1 of 4 = 25% → already earned, 0 needed", () => {
    const result = readingsToBadge(1, 4);
    expect(result.earned).toBe(true);
    expect(result.needed).toBe(0);
    expect(result.ratio).toBeCloseTo(0.25, 5);
  });

  it("1 of 3 → already above (33%), 0 needed", () => {
    const result = readingsToBadge(1, 3);
    expect(result.earned).toBe(true);
    expect(result.needed).toBe(0);
    expect(result.ratio).toBeCloseTo(1 / 3, 5);
  });

  it("0 verified of 10 → needs 4 more ((0+4)/(10+4) = 0.2857 ≥ 0.25; (0+3)/(10+3) = 0.2307 < 0.25)", () => {
    // 4 more verified → 4/14 ≈ 0.2857, passes 0.25 threshold
    // 3 more verified → 3/13 ≈ 0.2307, fails 0.25 threshold
    expect(readingsToBadge(0, 10)).toEqual({ earned: false, needed: 4, ratio: 0 });
  });

  it("2 of 10 → needs 1 more ((2+1)/(10+1) = 0.2727)", () => {
    const result = readingsToBadge(2, 10);
    expect(result.earned).toBe(false);
    expect(result.needed).toBe(1);
    expect(result.ratio).toBeCloseTo(0.2, 5);
  });

  it("1 verified of 2 = 50% → already earned", () => {
    const result = readingsToBadge(1, 2);
    expect(result.earned).toBe(true);
    expect(result.needed).toBe(0);
    expect(result.ratio).toBeCloseTo(0.5, 5);
  });

  it("treats 25 % exactly as earned (matches computeSessionStats boundary)", () => {
    // 5/20 = 0.25
    expect(readingsToBadge(5, 20).earned).toBe(true);
    // 4/20 = 0.2 → not earned
    expect(readingsToBadge(4, 20).earned).toBe(false);
  });

  it("never returns negative values for degenerate inputs", () => {
    // Defensive: verified > total shouldn't happen but shouldn't crash.
    const result = readingsToBadge(5, 3);
    expect(result.earned).toBe(true);
    expect(result.needed).toBe(0);
  });
});
