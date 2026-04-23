// Pure progress-ring helper used by the SPA dashboard + watch detail
// page. Answers "how many more verified readings does this watch's
// current session need to earn the 25 %+ verified badge?"
//
// The naive formula `ceil(0.25 * total) - verified` is wrong: adding
// verified readings grows the denominator too, so the true threshold
// is "the smallest non-negative n such that (verified + n) / (total +
// n) >= 0.25". We solve the inequality algebraically and round up:
//
//   (v + n) / (t + n) ≥ 0.25
//   v + n ≥ 0.25 * (t + n)
//   v + n ≥ 0.25t + 0.25n
//   0.75n ≥ 0.25t - v
//   n ≥ (0.25t - v) / 0.75    (equivalently: n ≥ (t - 4v) / 3)
//
// When `verified / total` is already ≥ 0.25 the right-hand side is
// ≤ 0 and `needed` is 0.
//
// `earned` mirrors computeSessionStats' verified_badge threshold
// exactly — 25 % or more.

export interface ReadingsToBadgeResult {
  /** True when (verified / total) >= 0.25. Matches verified_badge. */
  earned: boolean;
  /**
   * Non-negative count of additional verified readings needed to hit
   * the 25 % threshold. 0 when already earned.
   */
  needed: number;
  /** Current verified ratio; 0 when total is 0 to avoid NaN. */
  ratio: number;
}

export function readingsToBadge(
  verifiedCount: number,
  totalCount: number,
): ReadingsToBadgeResult {
  if (totalCount <= 0) {
    return { earned: false, needed: 0, ratio: 0 };
  }
  const ratio = Math.min(verifiedCount, totalCount) / totalCount;
  if (ratio >= 0.25) {
    return { earned: true, needed: 0, ratio };
  }
  // Solve: n ≥ (t - 4v) / 3. Round up; never below zero.
  const raw = (totalCount - 4 * verifiedCount) / 3;
  const needed = Math.max(0, Math.ceil(raw));
  return { earned: false, needed, ratio };
}
