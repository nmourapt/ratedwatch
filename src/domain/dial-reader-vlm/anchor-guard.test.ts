// Pure-function tests for the anchor-disagreement guard.
//
// The guard is the second half of the median-of-3 pipeline (slice #5
// of PRD #99 — issue #104). After `reader.ts` computes a median MM:SS
// from three parallel VLM reads, the guard checks the median against
// the EXIF anchor and against the individual read pattern, and either
// accepts or rejects/flags the result.
//
// Two failure modes the guard catches:
//
//   1. **anchor disagreement**: median MM:SS diverges from the
//      anchor by > 60s on the wrap-aware [0, 3600) MM:SS circle.
//      Mirrors the bake-off's `_signed_error_seconds` math but on the
//      MM:SS-only axis (3600s circle, 1800s half).
//
//   2. **anchor echo (cheat-flag)**: ALL three individual reads are
//      byte-identical to the anchor's MM:SS. The bake-off saw
//      Claude-style models do this — they ignore the dial entirely
//      and just echo the anchor we passed in the prompt as a "sanity
//      check". With three identical-to-anchor reads the probability
//      that a real dial coincidentally landed on exactly the anchor
//      MM:SS three times in a row is vanishingly small. Two of two
//      identical-to-anchor reads is NOT distinguishable from a real
//      read landing on the anchor by chance, so the cheat-flag only
//      fires when there are three reads.
//
// `accept` is the default — anything else routes to a rejection in
// the verifier.

import { describe, expect, it } from "vitest";
import { checkAnchor } from "./anchor-guard";

describe("checkAnchor", () => {
  describe("accept", () => {
    it("accepts when median matches anchor exactly and reads vary", () => {
      // Median is 19:30, anchor is 19:30. Individual reads diverge
      // from the anchor (so it's not a cheat). Real-world: three
      // independent reads of the same dial happened to land on the
      // anchor MM:SS — fine, just lucky.
      const result = checkAnchor({
        medianMmSs: { m: 19, s: 30 },
        anchorMmSs: { m: 19, s: 30 },
        individualReads: [
          { m: 19, s: 28 },
          { m: 19, s: 30 },
          { m: 19, s: 32 },
        ],
      });
      expect(result.kind).toBe("accept");
    });

    it("accepts when median is within 60s of anchor", () => {
      // dial 19:30, anchor 19:00 → +30s
      const result = checkAnchor({
        medianMmSs: { m: 19, s: 30 },
        anchorMmSs: { m: 19, s: 0 },
        individualReads: [
          { m: 19, s: 28 },
          { m: 19, s: 30 },
          { m: 19, s: 32 },
        ],
      });
      expect(result.kind).toBe("accept");
    });

    it("accepts at the +60s boundary (boundary is inclusive)", () => {
      // dial 20:00, anchor 19:00 → +60s
      const result = checkAnchor({
        medianMmSs: { m: 20, s: 0 },
        anchorMmSs: { m: 19, s: 0 },
        individualReads: [
          { m: 19, s: 58 },
          { m: 20, s: 0 },
          { m: 20, s: 2 },
        ],
      });
      expect(result.kind).toBe("accept");
    });

    it("accepts at the -60s boundary (boundary is inclusive)", () => {
      // dial 19:00, anchor 20:00 → -60s
      const result = checkAnchor({
        medianMmSs: { m: 19, s: 0 },
        anchorMmSs: { m: 20, s: 0 },
        individualReads: [
          { m: 18, s: 58 },
          { m: 19, s: 0 },
          { m: 19, s: 2 },
        ],
      });
      expect(result.kind).toBe("accept");
    });

    it("accepts when only 2 reads are present (cheat-flag does not fire on 2)", () => {
      // 2 of 2 reads byte-identical to anchor — by PRD design we
      // don't flag this because it's statistically indistinguishable
      // from two real reads coincidentally hitting the anchor.
      const result = checkAnchor({
        medianMmSs: { m: 19, s: 30 },
        anchorMmSs: { m: 19, s: 30 },
        individualReads: [
          { m: 19, s: 30 },
          { m: 19, s: 30 },
        ],
      });
      expect(result.kind).toBe("accept");
    });

    it("accepts wrap-around proximity (dial 59:30, anchor 0:30 → -60s)", () => {
      // The MM:SS circle wraps; the shortest distance between 59:30
      // and 0:30 is -60s, NOT +3540s.
      const result = checkAnchor({
        medianMmSs: { m: 59, s: 30 },
        anchorMmSs: { m: 0, s: 30 },
        individualReads: [
          { m: 59, s: 28 },
          { m: 59, s: 30 },
          { m: 59, s: 32 },
        ],
      });
      expect(result.kind).toBe("accept");
    });
  });

  describe("reject_anchor_disagreement", () => {
    it("rejects when median is +90s ahead of anchor", () => {
      // dial 20:30, anchor 19:00 → +90s, > 60s threshold
      const result = checkAnchor({
        medianMmSs: { m: 20, s: 30 },
        anchorMmSs: { m: 19, s: 0 },
        individualReads: [
          { m: 20, s: 28 },
          { m: 20, s: 30 },
          { m: 20, s: 32 },
        ],
      });
      expect(result.kind).toBe("reject_anchor_disagreement");
      if (result.kind === "reject_anchor_disagreement") {
        expect(result.delta_seconds).toBe(90);
      }
    });

    it("rejects when median is -90s behind anchor", () => {
      // dial 19:00, anchor 20:30 → -90s, |delta| > 60s
      const result = checkAnchor({
        medianMmSs: { m: 19, s: 0 },
        anchorMmSs: { m: 20, s: 30 },
        individualReads: [
          { m: 18, s: 58 },
          { m: 19, s: 0 },
          { m: 19, s: 2 },
        ],
      });
      expect(result.kind).toBe("reject_anchor_disagreement");
      if (result.kind === "reject_anchor_disagreement") {
        expect(result.delta_seconds).toBe(-90);
      }
    });

    it("rejects with wrap-aware delta (dial 30:00, anchor 0:00 → +1800s, picks shorter way → -1800s)", () => {
      // 30:00 vs 0:00 — half the circle. Shortest signed distance
      // could be either +1800 or -1800; convention from
      // _signed_error_seconds: pick the one that is ≤ 1800. We
      // settle on +1800 (anything 1800+ flips). |1800| > 60 → reject.
      const result = checkAnchor({
        medianMmSs: { m: 30, s: 0 },
        anchorMmSs: { m: 0, s: 0 },
        individualReads: [
          { m: 30, s: 0 },
          { m: 30, s: 0 },
          { m: 30, s: 0 },
        ],
      });
      expect(result.kind).toBe("reject_anchor_disagreement");
    });

    it("rejects just above the +60s threshold (61s diverged → reject)", () => {
      const result = checkAnchor({
        medianMmSs: { m: 20, s: 1 },
        anchorMmSs: { m: 19, s: 0 },
        individualReads: [
          { m: 20, s: 0 },
          { m: 20, s: 1 },
          { m: 20, s: 2 },
        ],
      });
      expect(result.kind).toBe("reject_anchor_disagreement");
      if (result.kind === "reject_anchor_disagreement") {
        expect(result.delta_seconds).toBe(61);
      }
    });
  });

  describe("flag_suspicious_anchor_echo", () => {
    it("flags when ALL THREE reads are byte-identical to the anchor", () => {
      // Classic Claude cheat: model echoes the anchor as its answer
      // three times in a row. Probability of three independent dial
      // reads coincidentally landing on exactly the anchor MM:SS is
      // ~(1/3600)^2 ≈ 7e-8. Flag and reject.
      const result = checkAnchor({
        medianMmSs: { m: 19, s: 24 },
        anchorMmSs: { m: 19, s: 24 },
        individualReads: [
          { m: 19, s: 24 },
          { m: 19, s: 24 },
          { m: 19, s: 24 },
        ],
      });
      expect(result.kind).toBe("flag_suspicious_anchor_echo");
    });

    it("does NOT flag when only 2 reads match the anchor (third diverges)", () => {
      // The cheat-flag heuristic requires all three to be identical
      // to the anchor. If even one read diverges, we treat it as a
      // real read pattern and rely on the disagreement check.
      const result = checkAnchor({
        medianMmSs: { m: 19, s: 24 },
        anchorMmSs: { m: 19, s: 24 },
        individualReads: [
          { m: 19, s: 24 },
          { m: 19, s: 24 },
          { m: 19, s: 30 }, // differs
        ],
      });
      expect(result.kind).toBe("accept");
    });

    it("does NOT flag with only 2 reads even if both match the anchor", () => {
      // PRD design: cheat-flag requires three reads. Two reads
      // matching the anchor is statistically plausible.
      const result = checkAnchor({
        medianMmSs: { m: 19, s: 24 },
        anchorMmSs: { m: 19, s: 24 },
        individualReads: [
          { m: 19, s: 24 },
          { m: 19, s: 24 },
        ],
      });
      expect(result.kind).toBe("accept");
    });
  });
});
