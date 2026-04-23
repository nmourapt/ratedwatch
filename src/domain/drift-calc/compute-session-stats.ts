// Pure drift-calc domain module.
//
// Given a list of Readings for a single watch, compute the session
// stats that the SPA (slice #13), the public watch page (slice #15)
// and the leaderboard ranker (slice #17) all need. A "session" starts
// at the most recent `is_baseline=true` reading and runs up to the
// latest reading.
//
// MUST stay pure: no imports from hono, kysely, workerd, or anything
// IO-bound. Everything here is plain arithmetic so it can be unit-
// tested without standing up a Worker.
//
// See AGENTS.md glossary for the vocabulary (Reading, Deviation, Drift
// rate, Baseline, Session, Verified reading, Verified watch).

export interface Reading {
  id: string;
  /** Unix ms. The authoritative time the watch was read against. */
  reference_timestamp: number;
  /** Signed seconds. Positive = watch ahead of reference. */
  deviation_seconds: number;
  /** true if this reading marks the start of a new session (deviation = 0 by definition). */
  is_baseline: boolean;
  /** true if derived from a camera capture (slice #16). */
  verified: boolean;
}

export interface PerIntervalDrift {
  from_reading_id: string;
  to_reading_id: string;
  /** Float days between the two readings' reference_timestamps. */
  interval_days: number;
  /** Seconds per day, signed. 0 when interval_days is 0 (no divide-by-zero). */
  drift_rate_spd: number;
}

export interface SessionStats {
  /** Days from the session baseline to the latest reading. 0 if no baseline exists. */
  session_days: number;
  /** Readings in the current session (inclusive of baseline). */
  reading_count: number;
  /** Fraction of session readings that are verified. 0..1. */
  verified_ratio: number;
  /** Null when there's nothing to average (< 2 readings in session). */
  avg_drift_rate_spd: number | null;
  /** One entry per pair of consecutive readings in the session. */
  per_interval: PerIntervalDrift[];
  /** True when the session qualifies for ranking (session_days >= 7 && reading_count >= 3). */
  eligible: boolean;
  /** True when verified_ratio >= 0.25. */
  verified_badge: boolean;
  /** Deviation on the most-recent reading in the session; 0 when empty. */
  latest_deviation_seconds: number;
  /** reference_timestamp of the session baseline; 0 when no baseline exists. */
  baseline_reference_timestamp: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Compute session stats from an unsorted list of readings.
 *
 * Session rules:
 *   * Session = readings since (and including) the LAST `is_baseline=true`.
 *   * No baseline in input → session_days=0, avg_drift=null, eligible=false,
 *     but reading_count is still total input so the UI can show *something*.
 *   * 0-day interval between two readings → drift_rate_spd=0 (not NaN/Infinity).
 *
 * Thresholds:
 *   * eligible ⇔ session_days ≥ 7 AND reading_count ≥ 3.
 *   * verified_badge ⇔ verified_ratio ≥ 0.25.
 */
export function computeSessionStats(readings: readonly Reading[]): SessionStats {
  if (readings.length === 0) {
    return emptyStats();
  }

  // Sort chronologically so we never assume the caller did.
  const sorted = [...readings].sort(
    (a, b) => a.reference_timestamp - b.reference_timestamp,
  );

  // Find the LAST baseline. If none, we degrade gracefully.
  let lastBaselineIdx = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i]!.is_baseline) {
      lastBaselineIdx = i;
      break;
    }
  }

  if (lastBaselineIdx === -1) {
    // No baseline — can't compute a drift session. Report total
    // reading count so the UI shows a "log a baseline to start" state.
    const latest = sorted[sorted.length - 1]!;
    const verifiedCount = sorted.filter((r) => r.verified).length;
    return {
      session_days: 0,
      reading_count: sorted.length,
      verified_ratio: sorted.length === 0 ? 0 : verifiedCount / sorted.length,
      avg_drift_rate_spd: null,
      per_interval: [],
      eligible: false,
      verified_badge: sorted.length > 0 && verifiedCount / sorted.length >= 0.25,
      latest_deviation_seconds: latest.deviation_seconds,
      baseline_reference_timestamp: 0,
    };
  }

  const sessionReadings = sorted.slice(lastBaselineIdx);
  const baseline = sessionReadings[0]!;
  const latest = sessionReadings[sessionReadings.length - 1]!;

  const perInterval: PerIntervalDrift[] = [];
  for (let i = 1; i < sessionReadings.length; i++) {
    const prev = sessionReadings[i - 1]!;
    const curr = sessionReadings[i]!;
    const intervalMs = curr.reference_timestamp - prev.reference_timestamp;
    const intervalDays = intervalMs / MS_PER_DAY;
    const deltaDev = curr.deviation_seconds - prev.deviation_seconds;
    const drift = intervalDays === 0 ? 0 : deltaDev / intervalDays;
    perInterval.push({
      from_reading_id: prev.id,
      to_reading_id: curr.id,
      interval_days: intervalDays,
      drift_rate_spd: drift,
    });
  }

  const avgDrift =
    sessionReadings.length < 2
      ? null
      : perInterval.reduce((sum, iv) => sum + iv.drift_rate_spd, 0) / perInterval.length;

  const sessionDays =
    (latest.reference_timestamp - baseline.reference_timestamp) / MS_PER_DAY;
  const verifiedCount = sessionReadings.filter((r) => r.verified).length;
  const verifiedRatio = verifiedCount / sessionReadings.length;

  return {
    session_days: sessionDays,
    reading_count: sessionReadings.length,
    verified_ratio: verifiedRatio,
    avg_drift_rate_spd: avgDrift,
    per_interval: perInterval,
    eligible: sessionDays >= 7 && sessionReadings.length >= 3,
    verified_badge: verifiedRatio >= 0.25,
    latest_deviation_seconds: latest.deviation_seconds,
    baseline_reference_timestamp: baseline.reference_timestamp,
  };
}

function emptyStats(): SessionStats {
  return {
    session_days: 0,
    reading_count: 0,
    verified_ratio: 0,
    avg_drift_rate_spd: null,
    per_interval: [],
    eligible: false,
    verified_badge: false,
    latest_deviation_seconds: 0,
    baseline_reference_timestamp: 0,
  };
}
