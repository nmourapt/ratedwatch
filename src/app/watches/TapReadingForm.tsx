// Tap-the-dial manual reading flow. Replaces the typed-deviation
// form (LogReadingForm.tsx — kept in the tree for now, marked
// deprecated) with a UX that mirrors how an enthusiast actually
// measures drift against a reference clock:
//
//   1. The user looks at their watch.
//   2. They wait for the second hand to cross one of the four
//      canonical marks — 12 (0), 3 (15), 6 (30), or 9 (45) o'clock.
//   3. At the moment it lands, they tap the matching button.
//   4. The server takes its own Date.now() as the reference and
//      computes the signed deviation.
//
// Latency matters because the tap IS the commit — we fire the POST
// immediately, show a transient "recorded" state, then revert to
// idle. The reloaded list/stats are fetched via `onLogged` in the
// background; the user doesn't wait on that round-trip.
//
// Accessibility: the four buttons are keyboard-focusable and their
// labels include both the numeric position and the clock-face
// reference ("12 o'clock · 0"). A live `<time>` updates 10× per
// second so the user can visually sync to the upcoming mark without
// mental math.

import { useEffect, useRef, useState } from "react";
import { createTapReading, type CreateTapReadingBody } from "./readings";

interface Props {
  watchId: string;
  onLogged: () => void;
}

type DialPosition = 0 | 15 | 30 | 45;

interface DialButton {
  position: DialPosition;
  oclock: string;
}

const DIAL_BUTTONS: readonly DialButton[] = [
  { position: 0, oclock: "12" },
  { position: 15, oclock: "3" },
  { position: 30, oclock: "6" },
  { position: 45, oclock: "9" },
] as const;

type Status =
  | { kind: "idle" }
  | { kind: "submitting"; position: DialPosition | "baseline" }
  | { kind: "recorded"; position: DialPosition | "baseline"; deviation: number }
  | { kind: "error"; message: string };

/** Format the signed deviation for the "recorded" toast. */
function formatDeviation(seconds: number): string {
  if (seconds === 0) return "0 s (dead-on)";
  const sign = seconds > 0 ? "+" : "";
  return `${sign}${seconds} s`;
}

export function TapReadingForm({ watchId, onLogged }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [showNotes, setShowNotes] = useState(false);
  const [notes, setNotes] = useState("");
  // Server-synced client clock for the "current second" indicator.
  // 100 ms cadence is fast enough that the user can visually sync to
  // the upcoming dial mark without it looking laggy.
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000) % 60);

  // Timer reference so StrictMode double-mount in dev doesn't leak
  // intervals. Cleanup also fires on unmount.
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    timerRef.current = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000) % 60);
    }, 100);
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // The transient "recorded" state reverts to idle after 1.6 s so the
  // user can tap again without manual dismissal.
  useEffect(() => {
    if (status.kind !== "recorded") return;
    const t = window.setTimeout(() => {
      setStatus({ kind: "idle" });
    }, 1600);
    return () => window.clearTimeout(t);
  }, [status]);

  async function submit(body: CreateTapReadingBody, label: DialPosition | "baseline") {
    setStatus({ kind: "submitting", position: label });
    // Collapse notes back so the next tap starts fresh.
    const payload: CreateTapReadingBody = notes.trim()
      ? { ...body, notes: notes.trim() }
      : body;
    const result = await createTapReading(watchId, payload);
    if (!result.ok) {
      setStatus({ kind: "error", message: result.error.message });
      return;
    }
    setNotes("");
    setShowNotes(false);
    setStatus({
      kind: "recorded",
      position: label,
      deviation: result.reading.deviation_seconds,
    });
    // Fire-and-forget — the parent re-fetches in the background while
    // we show the "recorded" toast.
    onLogged();
  }

  function handleTap(position: DialPosition) {
    void submit({ dial_position: position, is_baseline: false }, position);
  }

  function handleBaseline() {
    void submit({ dial_position: 0, is_baseline: true }, "baseline");
  }

  const isSubmitting = status.kind === "submitting";

  return (
    <section className="mb-6 rounded-lg border border-cf-border bg-cf-surface p-5">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium text-cf-text">Tap to log a reading</h2>
        <p
          className="font-mono text-xs text-cf-text-muted"
          aria-label={`Reference clock at ${nowSeconds} seconds`}
        >
          ref ·{" "}
          <time className="text-cf-accent">
            :{nowSeconds.toString().padStart(2, "0")}
          </time>
        </p>
      </div>
      <p className="mb-4 text-xs text-cf-text-muted">
        Wait for your watch&apos;s second hand to cross 12, 3, 6, or 9 o&apos;clock, then
        tap the matching position. The server uses its own clock as the reference.
      </p>

      {status.kind === "error" ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-cf-accent/40 bg-cf-accent/10 px-3 py-2 text-sm text-cf-text"
        >
          {status.message}
        </p>
      ) : null}
      {status.kind === "recorded" ? (
        <p
          role="status"
          aria-live="polite"
          className="mb-4 rounded-md border border-cf-accent/30 bg-cf-bg px-3 py-2 text-sm text-cf-text"
        >
          Recorded{" "}
          {status.position === "baseline" ? (
            <span className="font-mono text-cf-accent">baseline</span>
          ) : (
            <>
              tap at <span className="font-mono text-cf-accent">{status.position}</span>
              {" → "}
              <span className="font-mono text-cf-accent">
                {formatDeviation(status.deviation)}
              </span>
            </>
          )}
        </p>
      ) : null}

      <div
        role="group"
        aria-label="Dial positions"
        className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4"
      >
        {DIAL_BUTTONS.map(({ position, oclock }) => {
          const submittingThis =
            status.kind === "submitting" && status.position === position;
          return (
            <button
              key={position}
              type="button"
              onClick={() => handleTap(position)}
              disabled={isSubmitting}
              aria-label={`Tap at ${position} seconds (${oclock} o'clock)`}
              className="group flex flex-col items-center justify-center gap-1 rounded-lg border border-cf-border bg-cf-bg px-4 py-6 text-cf-text transition-colors hover:border-cf-accent hover:bg-cf-accent/5 focus:border-cf-accent focus:outline-none focus:ring-2 focus:ring-cf-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="font-mono text-3xl font-medium tabular-nums text-cf-text group-hover:text-cf-accent">
                {position}
              </span>
              <span className="text-xs text-cf-text-muted">{oclock} o&apos;clock</span>
              {submittingThis ? (
                <span className="text-xs text-cf-accent">Logging…</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleBaseline}
          disabled={isSubmitting}
          className="inline-flex items-center justify-center rounded-full border border-cf-accent/40 bg-cf-accent/10 px-4 py-2 text-xs font-medium text-cf-accent transition-colors hover:border-cf-accent hover:bg-cf-accent/20 disabled:opacity-60"
        >
          {status.kind === "submitting" && status.position === "baseline"
            ? "Saving baseline…"
            : "I just set my watch (baseline)"}
        </button>
        <button
          type="button"
          onClick={() => setShowNotes((s) => !s)}
          className="text-xs text-cf-text-muted hover:text-cf-text"
          aria-expanded={showNotes}
        >
          {showNotes ? "Hide notes" : "Add notes"}
        </button>
      </div>

      {showNotes ? (
        <label className="mt-3 block text-sm">
          <span className="sr-only">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={isSubmitting}
            rows={2}
            maxLength={500}
            placeholder="e.g. worn overnight face-up, 20ºC"
            className="w-full rounded-md border border-cf-border bg-cf-bg px-3 py-2 text-sm text-cf-text placeholder:text-cf-text-subtle focus:border-cf-accent focus:outline-none disabled:opacity-60"
          />
        </label>
      ) : null}
    </section>
  );
}
