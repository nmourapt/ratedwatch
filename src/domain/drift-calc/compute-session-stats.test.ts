// Unit tests for the pure drift-calc module. These run under the
// default vitest pool (node/workerd) and MUST stay import-free of any
// IO — the point of a pure module is that a product engineer can
// reason about drift math without standing up a database.
//
// Ubiquitous language (see AGENTS.md):
//   * Reading — a record of displayed time vs reference time
//   * Deviation — signed seconds the watch is ahead (+) or behind (-)
//   * Drift rate — change in deviation per day (s/d)
//   * Baseline — reading with is_baseline=true, deviation = 0
//   * Session — readings since and including the most recent baseline

import { describe, it, expect } from "vitest";
import { computeSessionStats, type Reading } from "./compute-session-stats";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fixture helper — builds a Reading with sane defaults. */
function r(partial: Partial<Reading> & { reference_timestamp: number }): Reading {
  return {
    id: partial.id ?? crypto.randomUUID(),
    reference_timestamp: partial.reference_timestamp,
    deviation_seconds: partial.deviation_seconds ?? 0,
    is_baseline: partial.is_baseline ?? false,
    verified: partial.verified ?? false,
  };
}

describe("computeSessionStats — empty / degenerate inputs", () => {
  it("returns safe zeros for an empty reading list", () => {
    const stats = computeSessionStats([]);
    expect(stats.reading_count).toBe(0);
    expect(stats.session_days).toBe(0);
    expect(stats.avg_drift_rate_spd).toBeNull();
    expect(stats.per_interval).toEqual([]);
    expect(stats.eligible).toBe(false);
    expect(stats.verified_badge).toBe(false);
    expect(stats.verified_ratio).toBe(0);
    expect(stats.latest_deviation_seconds).toBe(0);
    expect(stats.baseline_reference_timestamp).toBe(0);
  });

  it("handles a session with only a baseline (1 reading)", () => {
    const t = Date.UTC(2025, 0, 1);
    const stats = computeSessionStats([
      r({ id: "a", reference_timestamp: t, is_baseline: true }),
    ]);
    expect(stats.reading_count).toBe(1);
    expect(stats.session_days).toBe(0);
    expect(stats.avg_drift_rate_spd).toBeNull();
    expect(stats.per_interval).toEqual([]);
    expect(stats.eligible).toBe(false);
    expect(stats.latest_deviation_seconds).toBe(0);
    expect(stats.baseline_reference_timestamp).toBe(t);
  });

  it("no baseline in input — falls back to counting all readings but flags as ineligible", () => {
    // Useful for UI: the user logged readings without ever marking one
    // as baseline. We still want to show the list count.
    const t = Date.UTC(2025, 0, 1);
    const readings = [
      r({ id: "a", reference_timestamp: t, deviation_seconds: 1 }),
      r({ id: "b", reference_timestamp: t + DAY_MS, deviation_seconds: 2 }),
    ];
    const stats = computeSessionStats(readings);
    expect(stats.reading_count).toBe(2);
    expect(stats.session_days).toBe(0);
    expect(stats.avg_drift_rate_spd).toBeNull();
    expect(stats.eligible).toBe(false);
    expect(stats.baseline_reference_timestamp).toBe(0);
    expect(stats.per_interval).toEqual([]);
  });
});

describe("computeSessionStats — drift math edges", () => {
  it("two readings at 0 days apart → drift_rate_spd = 0 (no divide-by-zero)", () => {
    const t = Date.UTC(2025, 0, 1);
    const stats = computeSessionStats([
      r({ id: "a", reference_timestamp: t, is_baseline: true }),
      r({ id: "b", reference_timestamp: t, deviation_seconds: 5 }),
    ]);
    expect(stats.per_interval).toHaveLength(1);
    expect(stats.per_interval[0]!.drift_rate_spd).toBe(0);
    expect(Number.isFinite(stats.per_interval[0]!.drift_rate_spd)).toBe(true);
    expect(stats.avg_drift_rate_spd).toBe(0);
  });
});

describe("computeSessionStats — ordering + session reset", () => {
  it("sorts input chronologically before computing", () => {
    const t = Date.UTC(2025, 0, 1);
    // Provide intentionally out-of-order input
    const stats = computeSessionStats([
      r({ id: "c", reference_timestamp: t + 2 * DAY_MS, deviation_seconds: 4 }),
      r({ id: "a", reference_timestamp: t, is_baseline: true }),
      r({ id: "b", reference_timestamp: t + DAY_MS, deviation_seconds: 2 }),
    ]);
    expect(stats.per_interval).toHaveLength(2);
    expect(stats.per_interval[0]!.from_reading_id).toBe("a");
    expect(stats.per_interval[0]!.to_reading_id).toBe("b");
    expect(stats.per_interval[1]!.from_reading_id).toBe("b");
    expect(stats.per_interval[1]!.to_reading_id).toBe("c");
  });

  it("a new baseline mid-series restarts the session — earlier readings are dropped", () => {
    const t = Date.UTC(2025, 0, 1);
    const stats = computeSessionStats([
      r({ id: "old-1", reference_timestamp: t, is_baseline: true }),
      r({ id: "old-2", reference_timestamp: t + DAY_MS, deviation_seconds: 5 }),
      r({ id: "old-3", reference_timestamp: t + 2 * DAY_MS, deviation_seconds: 10 }),
      // User resets the watch to true time here:
      r({
        id: "new-baseline",
        reference_timestamp: t + 10 * DAY_MS,
        is_baseline: true,
      }),
      r({
        id: "latest",
        reference_timestamp: t + 14 * DAY_MS,
        deviation_seconds: 3,
      }),
    ]);
    expect(stats.reading_count).toBe(2); // only the last 2
    expect(stats.baseline_reference_timestamp).toBe(t + 10 * DAY_MS);
    expect(stats.session_days).toBe(4);
    expect(stats.per_interval).toHaveLength(1);
    expect(stats.per_interval[0]!.from_reading_id).toBe("new-baseline");
    expect(stats.per_interval[0]!.to_reading_id).toBe("latest");
    expect(stats.per_interval[0]!.drift_rate_spd).toBeCloseTo(0.75, 5);
  });
});

describe("computeSessionStats — eligibility thresholds", () => {
  it("7-day session with 3 readings (inclusive of baseline) → eligible, avg_drift correct", () => {
    const t = Date.UTC(2025, 0, 1);
    const stats = computeSessionStats([
      r({ id: "b0", reference_timestamp: t, is_baseline: true }),
      // Day 3: watch is +6s.  interval 0→3 days, drift 2 s/d.
      r({ id: "r1", reference_timestamp: t + 3 * DAY_MS, deviation_seconds: 6 }),
      // Day 7: watch is +14s. interval 3→7 days = 4d, Δ deviation = 8, drift 2 s/d.
      r({ id: "r2", reference_timestamp: t + 7 * DAY_MS, deviation_seconds: 14 }),
    ]);
    expect(stats.reading_count).toBe(3);
    expect(stats.session_days).toBe(7);
    expect(stats.per_interval).toHaveLength(2);
    expect(stats.per_interval[0]!.interval_days).toBeCloseTo(3, 5);
    expect(stats.per_interval[0]!.drift_rate_spd).toBeCloseTo(2, 5);
    expect(stats.per_interval[1]!.drift_rate_spd).toBeCloseTo(2, 5);
    expect(stats.avg_drift_rate_spd).toBeCloseTo(2, 5);
    expect(stats.eligible).toBe(true);
    expect(stats.latest_deviation_seconds).toBe(14);
  });

  it("6-day session with 3 readings → not eligible (fails session_days >= 7)", () => {
    const t = Date.UTC(2025, 0, 1);
    const stats = computeSessionStats([
      r({ id: "b0", reference_timestamp: t, is_baseline: true }),
      r({ id: "r1", reference_timestamp: t + 3 * DAY_MS, deviation_seconds: 3 }),
      r({ id: "r2", reference_timestamp: t + 6 * DAY_MS, deviation_seconds: 6 }),
    ]);
    expect(stats.reading_count).toBe(3);
    expect(stats.session_days).toBe(6);
    expect(stats.eligible).toBe(false);
  });

  it("7-day session with only 2 readings → not eligible (fails reading_count >= 3)", () => {
    const t = Date.UTC(2025, 0, 1);
    const stats = computeSessionStats([
      r({ id: "b0", reference_timestamp: t, is_baseline: true }),
      r({ id: "r1", reference_timestamp: t + 7 * DAY_MS, deviation_seconds: 7 }),
    ]);
    expect(stats.reading_count).toBe(2);
    expect(stats.session_days).toBe(7);
    expect(stats.eligible).toBe(false);
    expect(stats.avg_drift_rate_spd).toBeCloseTo(1, 5);
  });

  it("14-day, 5 readings → per-interval drifts are each correct and avg is the mean over intervals", () => {
    const t = Date.UTC(2025, 0, 1);
    // Irregular sampling with a deliberately uneven last interval.
    // deviations: 0, +3 @d3, +5 @d7, +8 @d10, +14 @d14
    // intervals: 3d (+3/3=1), 4d (+2/4=.5), 3d (+3/3=1), 4d (+6/4=1.5)
    // avg = (1 + .5 + 1 + 1.5)/4 = 1
    const stats = computeSessionStats([
      r({ id: "a", reference_timestamp: t, is_baseline: true }),
      r({ id: "b", reference_timestamp: t + 3 * DAY_MS, deviation_seconds: 3 }),
      r({ id: "c", reference_timestamp: t + 7 * DAY_MS, deviation_seconds: 5 }),
      r({ id: "d", reference_timestamp: t + 10 * DAY_MS, deviation_seconds: 8 }),
      r({ id: "e", reference_timestamp: t + 14 * DAY_MS, deviation_seconds: 14 }),
    ]);
    expect(stats.per_interval).toHaveLength(4);
    expect(stats.per_interval[0]!.drift_rate_spd).toBeCloseTo(1, 5);
    expect(stats.per_interval[1]!.drift_rate_spd).toBeCloseTo(0.5, 5);
    expect(stats.per_interval[2]!.drift_rate_spd).toBeCloseTo(1, 5);
    expect(stats.per_interval[3]!.drift_rate_spd).toBeCloseTo(1.5, 5);
    expect(stats.avg_drift_rate_spd).toBeCloseTo(1, 5);
    expect(stats.session_days).toBe(14);
    expect(stats.eligible).toBe(true);
  });
});

describe("computeSessionStats — verified ratio / badge", () => {
  it("1 verified of 4 = 0.25 → verified_badge = true (at the boundary)", () => {
    const t = Date.UTC(2025, 0, 1);
    const stats = computeSessionStats([
      r({ id: "a", reference_timestamp: t, is_baseline: true, verified: true }),
      r({ id: "b", reference_timestamp: t + DAY_MS, deviation_seconds: 1 }),
      r({ id: "c", reference_timestamp: t + 2 * DAY_MS, deviation_seconds: 2 }),
      r({ id: "d", reference_timestamp: t + 3 * DAY_MS, deviation_seconds: 3 }),
    ]);
    expect(stats.verified_ratio).toBeCloseTo(0.25, 5);
    expect(stats.verified_badge).toBe(true);
  });

  it("1 verified of 5 = 0.2 → verified_badge = false (below boundary)", () => {
    const t = Date.UTC(2025, 0, 1);
    const stats = computeSessionStats([
      r({ id: "a", reference_timestamp: t, is_baseline: true, verified: true }),
      r({ id: "b", reference_timestamp: t + DAY_MS, deviation_seconds: 1 }),
      r({ id: "c", reference_timestamp: t + 2 * DAY_MS, deviation_seconds: 2 }),
      r({ id: "d", reference_timestamp: t + 3 * DAY_MS, deviation_seconds: 3 }),
      r({ id: "e", reference_timestamp: t + 4 * DAY_MS, deviation_seconds: 4 }),
    ]);
    expect(stats.verified_ratio).toBeCloseTo(0.2, 5);
    expect(stats.verified_badge).toBe(false);
  });
});
