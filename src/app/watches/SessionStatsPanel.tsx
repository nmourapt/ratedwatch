// Read-only session stats panel that lives above the reading log on
// the watch detail page. Derives every display label from the raw
// SessionStats so there's no client-side drift math duplication.
//
// Design rules (AGENTS.md):
//   * Hide avg_drift when reading_count < 2 (no drift computable yet).
//   * Show eligibility + verified-badge as chips. Tone stays neutral
//     while the watch is ineligible; accent color when a milestone
//     is hit.

import type { SessionStats } from "./readings";

interface Props {
  stats: SessionStats | null;
}

function formatDays(days: number): string {
  const rounded = Math.round(days * 10) / 10;
  if (rounded === 1) return "1 day";
  return `${rounded} days`;
}

function formatDrift(spd: number): string {
  // Preserve the sign; round to 2 decimals so panel numbers stay
  // calm at read time. Sub-decimal precision is overkill for UI.
  const rounded = Math.round(spd * 100) / 100;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "" : "";
  return `${sign}${rounded.toFixed(2)} s/d`;
}

function formatDeviation(secs: number): string {
  const rounded = Math.round(secs * 10) / 10;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "" : "";
  return `${sign}${rounded.toFixed(1)} s`;
}

export function SessionStatsPanel({ stats }: Props) {
  if (!stats || stats.reading_count === 0) {
    return (
      <div className="mb-6 rounded-lg border border-cf-border bg-cf-surface px-5 py-4 text-sm text-cf-text-muted">
        <p className="mb-1 font-medium text-cf-text">No readings yet</p>
        <p>
          Log your first reading below. Mark it as a baseline to start a tracking session.
        </p>
      </div>
    );
  }

  // No baseline in the input → the API still returns reading_count >0
  // but session_days=0. Surface that state specifically.
  const hasSession = stats.baseline_reference_timestamp > 0;
  const showAvgDrift = stats.reading_count >= 2 && stats.avg_drift_rate_spd !== null;

  return (
    <div className="mb-6 rounded-lg border border-cf-border bg-cf-surface p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-sm font-medium text-cf-text">
          {hasSession ? "Current session" : "Readings logged"}
        </h2>
        {hasSession && stats.eligible ? (
          <span className="rounded-full border border-cf-accent/40 bg-cf-accent/10 px-2.5 py-0.5 text-xs font-medium text-cf-accent">
            Eligible
          </span>
        ) : hasSession ? (
          <span
            className="rounded-full border border-cf-border bg-cf-bg px-2.5 py-0.5 text-xs font-medium text-cf-text-muted"
            title="Eligible for ranking after 7 days and 3 readings"
          >
            Not eligible yet
          </span>
        ) : null}
        {stats.verified_badge ? (
          <span className="rounded-full border border-cf-accent/40 bg-cf-accent/10 px-2.5 py-0.5 text-xs font-medium text-cf-accent">
            Verified
          </span>
        ) : null}
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-cf-text-muted">Session length</dt>
          <dd className="mt-0.5 font-mono text-base text-cf-text">
            {hasSession ? formatDays(stats.session_days) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-cf-text-muted">Readings</dt>
          <dd className="mt-0.5 font-mono text-base text-cf-text">
            {stats.reading_count}
          </dd>
        </div>
        {showAvgDrift ? (
          <div>
            <dt className="text-cf-text-muted">Average drift</dt>
            <dd className="mt-0.5 font-mono text-base text-cf-text">
              {formatDrift(stats.avg_drift_rate_spd!)}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-cf-text-muted">Verified ratio</dt>
          <dd className="mt-0.5 font-mono text-base text-cf-text">
            {Math.round(stats.verified_ratio * 100)}%
          </dd>
        </div>
        {hasSession ? (
          <div>
            <dt className="text-cf-text-muted">Latest deviation</dt>
            <dd className="mt-0.5 font-mono text-base text-cf-text">
              {formatDeviation(stats.latest_deviation_seconds)}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
