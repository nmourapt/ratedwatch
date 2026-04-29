// Snapshot tests for the chain-of-thought prompt builder.
//
// The prompt is the lever that controls the model's accuracy — it is
// derived from `scripts/vlm-bakeoff/bakeoff.py::_build_prompt` and
// the bake-off numbers (production-realistic round, MM:SS error ≤ 5s
// on 18/18 runs at offset ≤ 10s) are conditional on this exact text.
// A snapshot is the cheapest possible way to make any future edit
// fail noisily so we can reconcile against the bake-off harness.

import { describe, expect, it } from "vitest";
import { buildPrompt } from "./prompt";

describe("buildPrompt", () => {
  it("snapshots a typical anchor", () => {
    expect(buildPrompt({ h: 10, m: 19, s: 24 })).toMatchSnapshot();
  });

  it("snapshots a single-digit hour anchor", () => {
    expect(buildPrompt({ h: 9, m: 5, s: 1 })).toMatchSnapshot();
  });

  it("snapshots a midnight-adjacent anchor (hour 12)", () => {
    expect(buildPrompt({ h: 12, m: 0, s: 0 })).toMatchSnapshot();
  });

  it("includes the anchor as HH:MM:SS in the prompt body", () => {
    const out = buildPrompt({ h: 10, m: 19, s: 24 });
    expect(out).toContain("10:19:24");
  });

  it("includes the chain-of-thought identification block", () => {
    const out = buildPrompt({ h: 10, m: 19, s: 24 });
    expect(out).toContain("IDENTIFY THE THREE HANDS");
    expect(out).toContain("CLASSIFY each hand");
    expect(out).toContain("READ EACH HAND'S POSITION");
  });

  it("instructs the model NOT to echo the anchor", () => {
    // Anti-cheat instruction is critical: in the bake-off Anthropic
    // models echo the anchor verbatim if not told otherwise.
    expect(buildPrompt({ h: 10, m: 19, s: 24 })).toContain("DO NOT just echo");
  });

  it("formats single-digit hours with a leading zero", () => {
    // The HH:MM:SS extractor is permissive (single-digit H accepted)
    // but the anchor we *send to the model* should be a tidy HH:MM:SS
    // so chain-of-thought "compare anchor's minute to your read" works
    // without the model getting confused by single-digit anomalies.
    const out = buildPrompt({ h: 9, m: 5, s: 1 });
    expect(out).toContain("09:05:01");
  });
});
