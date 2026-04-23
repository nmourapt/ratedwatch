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
    <div className="mb-6 overflow-hidden rounded-lg border border-cf-border bg-cf-bg-200">
      <div className="border-b border-cf-border px-5 py-3 text-sm font-medium text-cf-text">
        Reading log
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-cf-bg-100 text-left text-xs uppercase tracking-wide text-cf-text-subtle">
            <tr>
              <th className="px-4 py-2">Reference time</th>
              <th className="px-4 py-2">Deviation</th>
              <th className="px-4 py-2">Drift since prev</th>
              <th className="px-4 py-2">Verified</th>
              <th className="px-4 py-2">Notes</th>
              <th className="px-4 py-2" aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {displayReadings.map((r) => {
              const drift = driftByToId.get(r.id);
              return (
                <tr
                  key={r.id}
                  className="border-t border-cf-border align-top first:border-t-0"
                >
                  <td className="px-4 py-3 font-mono text-xs text-cf-text">
                    {formatTime(r.reference_timestamp)}
                    {r.is_baseline ? (
                      <span className="ml-2 rounded-full border border-cf-orange/40 bg-cf-orange/10 px-1.5 py-0.5 text-[10px] font-medium text-cf-orange">
                        baseline
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 font-mono text-cf-text">
                    {formatDeviation(r.deviation_seconds)}
                  </td>
                  <td className="px-4 py-3 font-mono text-cf-text-muted">
                    {drift === undefined ? "—" : formatDrift(drift)}
                  </td>
                  <td className="px-4 py-3 text-cf-text-muted">
                    {r.verified ? "✓" : "—"}
                  </td>
                  <td className="px-4 py-3 text-cf-text-muted">
                    {r.notes ? r.notes : ""}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => handleDelete(r.id)}
                      disabled={deletingId === r.id}
                      className="text-xs text-cf-text-muted transition-colors hover:text-cf-orange disabled:opacity-60"
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
