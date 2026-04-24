// Reading log table. Shows every reading in reverse-chronological
// order with its deviation, reference time, the drift rate since the
// previous reading (if computable), a verified tick, notes, and a
// delete button.
//
// Drift per row is pulled from the `session_stats.per_interval` array
// so we reuse the pure drift-calc result rather than recomputing on
// the client. Readings outside the current session (i.e. before the
// last baseline) render "—" for drift.

import { useState } from "react";
import { deleteReading, type PerIntervalDrift, type Reading } from "./readings";

interface Props {
  readings: Reading[];
  perInterval: PerIntervalDrift[];
  onDeleted: () => void;
}

function formatDeviation(secs: number): string {
  const rounded = Math.round(secs * 100) / 100;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "" : "";
  return `${sign}${rounded.toFixed(2)} s`;
}

function formatDrift(spd: number): string {
  const rounded = Math.round(spd * 100) / 100;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "" : "";
  return `${sign}${rounded.toFixed(2)} s/d`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function ReadingList({ readings, perInterval, onDeleted }: Props) {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  if (readings.length === 0) {
    return null;
  }

  // Build a lookup: to_reading_id -> drift rate. The array is session-
  // scoped, so readings outside the current session legitimately have
  // no entry and render "—".
  const driftByToId = new Map<string, number>();
  for (const iv of perInterval) {
    driftByToId.set(iv.to_reading_id, iv.drift_rate_spd);
  }

  // Display newest-first — the API returns oldest-first so per-interval
  // math is stable. We copy + reverse so we don't mutate the prop.
  const displayReadings = [...readings].reverse();

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this reading? This cannot be undone.")) return;
    setDeletingId(id);
    const res = await deleteReading(id);
    setDeletingId(null);
    if (!res.ok) {
      window.alert(res.error.message);
      return;
    }
    onDeleted();
  }

  return (
    <div className="mb-6 overflow-hidden rounded-card border border-line bg-canvas shadow-card">
      <div className="border-b border-line-subtle bg-canvas px-6 py-4 text-xs font-medium uppercase tracking-wide text-ink-muted">
        Reading log
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-canvas text-left text-xs font-medium uppercase tracking-wide text-ink-subtle">
            <tr>
              <th className="px-4 py-3">Reference time</th>
              <th className="px-4 py-3">Deviation</th>
              <th className="px-4 py-3">Drift since prev</th>
              <th className="px-4 py-3">Verified</th>
              <th className="px-4 py-3">Notes</th>
              <th className="px-4 py-3" aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {displayReadings.map((r) => {
              const drift = driftByToId.get(r.id);
              return (
                <tr
                  key={r.id}
                  className="border-t border-line-subtle align-top transition-colors first:border-t-0 hover:bg-surface-inset"
                >
                  <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink">
                    {formatTime(r.reference_timestamp)}
                    {r.is_baseline ? (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-pill border border-accent/25 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                        baseline
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums text-ink">
                    {formatDeviation(r.deviation_seconds)}
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums text-ink-muted">
                    {drift === undefined ? "—" : formatDrift(drift)}
                  </td>
                  <td className="px-4 py-3 text-ink-muted">{r.verified ? "✓" : "—"}</td>
                  <td className="px-4 py-3 text-ink-muted">{r.notes ? r.notes : ""}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => handleDelete(r.id)}
                      disabled={deletingId === r.id}
                      className="text-xs text-ink-muted transition-colors hover:text-accent disabled:opacity-60"
                    >
                      {deletingId === r.id ? "Deleting…" : "Delete"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
