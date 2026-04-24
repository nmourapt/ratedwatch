// @deprecated — typed-deviation form. Superseded by TapReadingForm
// (tap-the-dial UX) in the watch detail page; kept in the tree for
// one release cycle so we can revert quickly if the tap UX falls
// over in the wild. Safe to delete once the tap flow has had real-
// world use. The backing POST /readings endpoint is still live and
// the new tap UX runs on POST /readings/tap.
//
// "Log a manual reading" form. Lives below the session stats panel
// on the watch detail page. Submits to POST /api/v1/watches/:id/readings
// via the readings API client.
//
// UX notes:
//   * "This is a baseline" checkbox — when checked, disables the
//     deviation input and forces its visual state to 0. The server
//     enforces the same rule defensively.
//   * Reference time defaults to "now" (Date.now()), editable via a
//     standard datetime-local input. The server stores unix ms;
//     conversion happens here.
//   * Success/failure are reported back to the parent via `onLogged`
//     (the parent reloads the list + stats).

import { useState, type FormEvent } from "react";
import { createReading } from "./readings";

interface Props {
  watchId: string;
  onLogged: () => void;
}

/**
 * Turn a <input type="datetime-local"> value into unix ms. The input
 * emits local-TZ strings like "2025-01-15T14:30"; Date() parses them
 * in the browser's local timezone which is what the user expects.
 */
function localInputToMs(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Format a unix ms timestamp as a local-TZ datetime-local value so
 * the input populates correctly on mount. `Date.toISOString()` uses
 * UTC — we need the local equivalent, trimmed to minute precision.
 */
function msToLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function LogReadingForm({ watchId, onLogged }: Props) {
  const [deviationInput, setDeviationInput] = useState("");
  const [isBaseline, setIsBaseline] = useState(false);
  const [refInput, setRefInput] = useState(() => msToLocalInput(Date.now()));
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    const referenceMs = localInputToMs(refInput);
    if (referenceMs === null) {
      setError("Reference time is required");
      return;
    }

    const deviation = isBaseline ? 0 : Number.parseFloat(deviationInput);
    if (!isBaseline && !Number.isFinite(deviation)) {
      setFieldErrors({ deviation_seconds: "Deviation is required" });
      return;
    }

    setSubmitting(true);
    const result = await createReading(watchId, {
      reference_timestamp: referenceMs,
      deviation_seconds: deviation,
      is_baseline: isBaseline,
      notes: notes.trim() || undefined,
    });
    setSubmitting(false);

    if (!result.ok) {
      setError(result.error.message);
      setFieldErrors(result.error.fieldErrors ?? {});
      return;
    }

    // Reset the form for the next entry, keep the reference time at
    // "now" so rapid-fire logging works without edits.
    setDeviationInput("");
    setIsBaseline(false);
    setRefInput(msToLocalInput(Date.now()));
    setNotes("");
    onLogged();
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="mb-6 rounded-lg border border-line bg-surface p-5"
    >
      <h2 className="mb-4 text-sm font-medium text-ink">Log a reading</h2>

      {error ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink"
        >
          {error}
        </p>
      ) : null}

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-muted">
            Deviation (seconds){" "}
            <span
              className="text-ink-subtle"
              title="Positive if watch is AHEAD of reference time; negative if behind"
            >
              ⓘ
            </span>
          </span>
          <input
            type="number"
            step="0.1"
            inputMode="decimal"
            value={isBaseline ? "0" : deviationInput}
            onChange={(e) => setDeviationInput(e.target.value)}
            disabled={isBaseline || submitting}
            placeholder="e.g. 2.5 or -1.3"
            aria-invalid={!!fieldErrors.deviation_seconds}
            className="w-full rounded-md border border-line bg-canvas px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none disabled:opacity-60"
          />
          {fieldErrors.deviation_seconds ? (
            <span className="mt-1 block text-xs text-accent">
              {fieldErrors.deviation_seconds}
            </span>
          ) : null}
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-ink-muted">Reference time</span>
          <input
            type="datetime-local"
            value={refInput}
            onChange={(e) => setRefInput(e.target.value)}
            disabled={submitting}
            className="w-full rounded-md border border-line bg-canvas px-3 py-2 font-mono text-sm text-ink focus:border-accent focus:outline-none disabled:opacity-60"
          />
        </label>
      </div>

      <label className="mb-4 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={isBaseline}
          onChange={(e) => setIsBaseline(e.target.checked)}
          disabled={submitting}
          className="mt-0.5 h-4 w-4 rounded border-line text-accent focus:ring-accent"
        />
        <span>
          <span className="text-ink">This is a baseline</span>
          <span className="ml-1 text-ink-muted">
            — watch just set to the exact time; deviation = 0
          </span>
        </span>
      </label>

      <label className="mb-4 block text-sm">
        <span className="mb-1 block text-ink-muted">Notes (optional)</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={submitting}
          rows={2}
          maxLength={500}
          className="w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none disabled:opacity-60"
          placeholder="e.g. worn overnight face-up, 20ºC"
        />
      </label>

      <button
        type="submit"
        disabled={submitting}
        className="inline-flex items-center justify-center rounded-full border border-accent bg-accent px-5 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-accent/90 disabled:opacity-60"
      >
        {submitting ? "Logging…" : "Log reading"}
      </button>
    </form>
  );
}
