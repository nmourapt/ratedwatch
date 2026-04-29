// Pure helpers for the verified-reading SPA confirmation page (slice
// #7 of PRD #99 — issue #106).
//
// The confirmation page renders the VLM's predicted MM:SS and lets
// the user nudge ± seconds before saving. Two invariants drive the
// logic:
//
//   1. Wrap-aware seconds math. When the user clicks +1 with seconds
//      at 59, the result is `m+1, s=0` — NOT clamping at 59 (that
//      would leak "you've hit the natural maximum" as a deviation
//      hint). Wrapping past the 60-minute boundary is theoretically
//      possible but practically impossible inside the ±30s adjustment
//      window; we still handle the modulo to be safe.
//
//   2. Wrap-aware "clicks used" calculation on the [0, 3600) MM:SS
//      circle. Going +1 from 59m 59s lands at 0m 0s — that's a 1s
//      adjustment, not a 3599s one. The shortest-distance metric
//      mirrors `mmSsCircularDistance` in `src/server/routes/readings.ts`
//      so client and server agree on what "30s away" means.
//
// The ±30s cap is enforced server-side (slice #6) — these helpers
// drive the UI's "disable + at the limit" behaviour. The server is
// the security boundary.

export interface MmSs {
  m: number;
  s: number;
}

/**
 * The per-click adjustment cap in seconds. Mirrors
 * `CONFIRM_ADJUSTMENT_LIMIT_SECONDS` in `src/server/routes/readings.ts`.
 * Adjustments beyond this require a retake.
 */
export const ADJUSTMENT_LIMIT_SECONDS = 30;

/**
 * Adjust an MM:SS pair by `delta` seconds, wrapping minute boundaries.
 * `delta` may be any integer; positive means later, negative earlier.
 *
 * Wrap math: total seconds = m*60 + s, then adjust modulo 3600 to
 * stay on the [0, 3600) MM:SS circle (which is what the watch dial
 * itself represents — minutes wrap every hour). Negative results are
 * lifted into the positive range with the canonical
 * `((x % n) + n) % n` idiom.
 */
export function adjustSeconds(current: MmSs, delta: number): MmSs {
  const total = current.m * 60 + current.s + delta;
  const wrapped = ((total % 3600) + 3600) % 3600;
  return { m: Math.floor(wrapped / 60), s: wrapped % 60 };
}

/**
 * Wrap-aware shortest signed distance between two MM:SS pairs on
 * the [0, 3600) circle. Returns seconds in [-1800, +1800].
 *
 * Mirrors `mmSsCircularDistance` in the route handler so the SPA's
 * "X / 30 used" counter matches the server's adjustment-cap math
 * exactly.
 */
export function mmSsCircularDistance(a: MmSs, b: MmSs): number {
  const aTotal = a.m * 60 + a.s;
  const bTotal = b.m * 60 + b.s;
  const raw = aTotal - bTotal;
  const wrapped = (((raw + 1800) % 3600) + 3600) % 3600;
  return wrapped - 1800;
}

/**
 * Absolute seconds the user has nudged away from the prediction,
 * clamped to non-negative integers. Drives the "± X / 30 used" UI
 * counter and the +/- button disable state.
 */
export function clicksUsed(predicted: MmSs, current: MmSs): number {
  return Math.abs(mmSsCircularDistance(current, predicted));
}

/**
 * Whether nudging ± seconds further would cross the ±30s cap.
 * Disable the corresponding button when this returns true.
 *
 * NOTE: we look at the *signed* distance, not just the absolute. A
 * user at -30 should still be able to click + (moving toward
 * predicted), but not - (moving away). Symmetric for +30.
 */
export function canAdjust(predicted: MmSs, current: MmSs, delta: 1 | -1): boolean {
  const next = adjustSeconds(current, delta);
  const nextDist = Math.abs(mmSsCircularDistance(next, predicted));
  return nextDist <= ADJUSTMENT_LIMIT_SECONDS;
}

/**
 * Format an MM:SS pair as "MM:SS" with zero padding. Used for the
 * big display + a11y labels.
 */
export function formatMmSs(mmSs: MmSs): string {
  const m = String(mmSs.m).padStart(2, "0");
  const s = String(mmSs.s).padStart(2, "0");
  return `${m}:${s}`;
}
