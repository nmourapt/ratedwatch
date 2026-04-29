// Anchor-disagreement guard.
//
// Slice #5 of PRD #99 (issue #104). The reader fans out three
// parallel VLM calls, computes a median MM:SS, and then asks this
// module: "Is the median trustworthy given the anchor and the
// individual read pattern?"
//
// Two checks:
//
//   1. **anchor disagreement** — the median MM:SS diverges from the
//      EXIF anchor MM:SS by more than 60 s on the wrap-aware
//      [0, 3600) MM:SS circle. A real watch in a tracked session is
//      bounded to a few minutes of drift; > 60 s on a single capture
//      means either the model misread the dial, or the anchor is
//      wrong. Either way the reading isn't safe to write.
//
//      The 60 s threshold is PRD-specified (issue #104 acceptance
//      criteria). The wrap-aware delta math mirrors
//      `scripts/vlm-bakeoff/bakeoff.py::_signed_error_seconds` —
//      mapped down from the 12-hour 43200 s circle to the MM:SS-only
//      3600 s circle. Picking the shorter way around the circle
//      means a dial straddling the minute boundary (dial 59:58 vs
//      anchor 0:02) reads as -4 s rather than +3596 s.
//
//   2. **anchor echo (cheat-flag)** — all three individual reads are
//      byte-identical to the anchor MM:SS. The bake-off saw
//      Claude-style models do this: they ignore the dial entirely
//      and just echo the anchor we passed in the prompt as a sanity
//      check. With three independent reads the joint probability of
//      coincidentally hitting exactly the anchor MM:SS three times
//      is ~(1/3600)² ≈ 7e-8, so we treat this pattern as a guaranteed
//      cheat and flag.
//
//      With only two reads (the median-of-2 fallback when one read
//      is unparseable) we do NOT fire the cheat-flag — two reads
//      matching the anchor isn't statistically distinguishable from
//      two real reads coincidentally landing on it.
//
// Pure function. No env, no I/O. The verifier is the only caller.

/**
 * Outcome of the guard. The verifier maps each variant to an error
 * code (or, for `accept`, lets the reading through to deviation
 * computation).
 */
export type GuardResult =
  | { kind: "accept" }
  | { kind: "reject_anchor_disagreement"; delta_seconds: number }
  | { kind: "flag_suspicious_anchor_echo" };

/** MM:SS pair — m ∈ [0, 59], s ∈ [0, 59]. */
interface MmSs {
  m: number;
  s: number;
}

/** Inputs to the guard. */
export interface CheckAnchorInput {
  medianMmSs: MmSs;
  anchorMmSs: MmSs;
  individualReads: MmSs[];
}

const SECONDS_PER_HOUR = 3600;
const HALF_HOUR_SECONDS = 1800;

/** Signed delta in seconds, wrapped into [-1800, +1800] on the MM:SS circle. */
function signedMmSsDelta(a: MmSs, b: MmSs): number {
  const aTotal = a.m * 60 + a.s;
  const bTotal = b.m * 60 + b.s;
  const diff =
    (((aTotal - bTotal) % SECONDS_PER_HOUR) + SECONDS_PER_HOUR) % SECONDS_PER_HOUR;
  // Pick the shorter way around the circle. > 1800 wraps the other
  // direction; the half-circle (=1800) stays positive so a dial 30
  // minutes off the anchor reports as +1800 (rejected anyway).
  return diff > HALF_HOUR_SECONDS ? diff - SECONDS_PER_HOUR : diff;
}

/** True iff `a` and `b` are byte-identical MM:SS pairs. */
function mmSsEqual(a: MmSs, b: MmSs): boolean {
  return a.m === b.m && a.s === b.s;
}

/**
 * Run the guard. Pure; never throws.
 *
 * Order of checks:
 *   1. anchor-echo cheat-flag (only when there are ≥ 3 reads)
 *   2. anchor-disagreement (> 60 s on the wrap-aware MM:SS circle)
 *   3. accept
 *
 * The cheat-flag fires before the disagreement check because an
 * all-anchor-echo set of reads is, by definition, in agreement with
 * the anchor — the disagreement check would let it through. We want
 * to surface "this is suspicious" instead of "this is fine".
 */
export function checkAnchor(input: CheckAnchorInput): GuardResult {
  const { medianMmSs, anchorMmSs, individualReads } = input;

  // Cheat-flag: three reads, all identical to the anchor.
  if (
    individualReads.length >= 3 &&
    individualReads.every((r) => mmSsEqual(r, anchorMmSs))
  ) {
    return { kind: "flag_suspicious_anchor_echo" };
  }

  // Disagreement: |median - anchor| > 60s on the wrap-aware circle.
  const delta = signedMmSsDelta(medianMmSs, anchorMmSs);
  if (Math.abs(delta) > 60) {
    return { kind: "reject_anchor_disagreement", delta_seconds: delta };
  }

  return { kind: "accept" };
}
