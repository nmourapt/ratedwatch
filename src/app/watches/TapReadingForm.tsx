// Tap-the-dial manual reading flow. Supersedes the typed-deviation
// form that shipped with slice #12 (deleted once this UX went live).
// The new shape mirrors how an enthusiast actually measures drift
// against a reference clock:
//
//   1. The user looks at their watch.
//   2. They wait for the second hand to cross one of the four
//      canonical marks — 12 (0), 3 (15), 6 (30), or 9 (45) o'clock.
//   3. At the moment it lands, they tap the matching position on a
//      circular dial that mirrors the watch face.
//   4. The server takes its own Date.now() as the reference and
//      computes the signed deviation.
//
// Latency matters because the tap IS the commit — we fire the POST
// immediately, show a transient "recorded" state, then revert to
// idle. The reloaded list/stats are fetched via `onLogged` in the
// background; the user doesn't wait on that round-trip.
//
// The dial is an SVG (faint circle + 12 tick marks) with four
// round buttons absolutely positioned at the 12/3/6/9 o'clock
// positions of that circle. The button positions match where the
// user's second hand is pointing, so the layout is self-explanatory
// without verbose helper text. See `DIAL_DIAMETER` / `BUTTON_SIZE`
// for the layout constants; the container shrinks on narrow screens
// via the `min()` expression.
//
// Accessibility: each button carries an `aria-label` naming the
// o'clock position it represents so screen readers convey what a
// sighted user would read off the positions. The live wall-clock in
// the header uses `aria-label` so assistive tech reads the full
// time, not just the numeric monospace text.

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
  /** Angle (degrees) on the dial where 0° is 12 o'clock and 90° is 3. */
  angleDeg: number;
}

const DIAL_BUTTONS: readonly DialButton[] = [
  { position: 0, oclock: "12", angleDeg: 0 },
  { position: 15, oclock: "3", angleDeg: 90 },
  { position: 30, oclock: "6", angleDeg: 180 },
  { position: 45, oclock: "9", angleDeg: 270 },
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

/** Zero-pad to two digits. Replaces `.padStart(2, "0")` inline noise. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Current wall-clock HH:MM:SS in the browser's local time. */
function formatLocalClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// Dial layout. Responsive: the container uses `min(...)` so the
// dial shrinks on very narrow screens. These defaults target the
// ~256px baseline that the design spec calls for; the SVG scales
// via `viewBox`, and the buttons are positioned in % of the
// container so percentages hold regardless of actual pixel size.
const DIAL_MIN_PX = 220;
const DIAL_DEFAULT_PX = 260;
const BUTTON_SIZE_PX = 56;

/**
 * Compute the {left, top} CSS offsets (as % strings) for a tap
 * button at a given angle on the dial. Angle 0 = 12 o'clock.
 *
 * We place buttons along a circle slightly inside the dial's own
 * outer edge so their centers land on the outer ring rather than
 * spilling past it. The ratio below (0.38 of container) is the
 * button-center radius — tuned so a 56px button on a 260px dial
 * reads as sitting "on" the ring, not balanced on top of it.
 */
function buttonOffset(angleDeg: number): { left: string; top: string } {
  const angleRad = (angleDeg * Math.PI) / 180;
  // Center of container is (50%, 50%); button center sits at radius
  // 0.38 * containerWidth.
  const rFraction = 0.38;
  const dx = Math.sin(angleRad) * rFraction;
  const dy = -Math.cos(angleRad) * rFraction;
  return {
    left: `${(0.5 + dx) * 100}%`,
    top: `${(0.5 + dy) * 100}%`,
  };
}

export function TapReadingForm({ watchId, onLogged }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [showNotes, setShowNotes] = useState(false);
  const [notes, setNotes] = useState("");
  // Wall-clock millis for the header's HH:MM:SS display. 100 ms
  // cadence is fast enough that the user can sync visually to the
  // upcoming dial mark without it looking laggy.
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Timer reference so StrictMode double-mount in dev doesn't leak
  // intervals. Cleanup also fires on unmount.
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    timerRef.current = window.setInterval(() => {
      setNowMs(Date.now());
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
  const clockLabel = formatLocalClock(nowMs);

  return (
    <section className="mb-6 rounded-lg border border-line bg-surface p-5">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-ink-muted">
          Tap to log a reading
        </h2>
        <time
          className="font-mono text-sm tabular-nums text-ink"
          aria-label={`Current reference time ${clockLabel}`}
        >
          {clockLabel}
        </time>
      </div>
      <p className="mb-5 text-xs text-ink-muted">
        Tap the matching position as your second hand passes over it.
      </p>

      {status.kind === "error" ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink"
        >
          {status.message}
        </p>
      ) : null}
      {status.kind === "recorded" ? (
        <p
          role="status"
          aria-live="polite"
          className="mb-4 rounded-md border border-accent/30 bg-canvas px-3 py-2 text-sm text-ink"
        >
          Recorded{" "}
          {status.position === "baseline" ? (
            <span className="font-mono text-accent">baseline</span>
          ) : (
            <>
              tap at <span className="font-mono text-accent">{status.position}</span>
              {" → "}
              <span className="font-mono text-accent">
                {formatDeviation(status.deviation)}
              </span>
            </>
          )}
        </p>
      ) : null}

      {/* Circular dial. `min(...)` keeps the layout legible on very
          narrow viewports — the dial shrinks from 260 to ~220px and
          the SVG scales with its container. */}
      <div
        role="group"
        aria-label="Dial positions"
        className="relative mx-auto mb-6"
        style={{
          width: `min(${DIAL_DEFAULT_PX}px, 100%)`,
          aspectRatio: "1 / 1",
          minWidth: `${DIAL_MIN_PX}px`,
        }}
      >
        {/* Background face: faint border ring + tick marks at the
            12 cardinal positions. The SVG uses `viewBox` so it
            scales automatically to the container size. */}
        <svg
          viewBox="0 0 100 100"
          className="absolute inset-0 h-full w-full"
          aria-hidden="true"
          role="img"
        >
          <circle
            cx="50"
            cy="50"
            r="47"
            className="fill-canvas stroke-line"
            strokeWidth="0.6"
          />
          {/* 12 tick marks — long at 12/3/6/9 (cardinals), short
              for the rest. Rotated around the center of the dial. */}
          {Array.from({ length: 12 }, (_, i) => {
            const angle = i * 30;
            const cardinal = i % 3 === 0;
            return (
              <line
                key={i}
                x1="50"
                y1={cardinal ? 5 : 7}
                x2="50"
                y2={cardinal ? 11 : 10}
                transform={`rotate(${angle} 50 50)`}
                className="stroke-line"
                strokeWidth={cardinal ? 1.2 : 0.6}
                strokeLinecap="round"
              />
            );
          })}
        </svg>

        {DIAL_BUTTONS.map(({ position, oclock, angleDeg }) => {
          const submittingThis =
            status.kind === "submitting" && status.position === position;
          const { left, top } = buttonOffset(angleDeg);
          return (
            <button
              key={position}
              type="button"
              onClick={() => handleTap(position)}
              disabled={isSubmitting}
              aria-label={`Tap when second hand is at ${oclock} o'clock (${position} seconds)`}
              className="absolute flex items-center justify-center rounded-full border border-line bg-surface font-mono text-xl font-medium tabular-nums text-ink shadow-sm transition-colors hover:border-accent hover:bg-accent/10 hover:text-accent focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-60"
              style={{
                width: `${BUTTON_SIZE_PX}px`,
                height: `${BUTTON_SIZE_PX}px`,
                left,
                top,
                transform: "translate(-50%, -50%)",
              }}
            >
              {submittingThis ? (
                <span className="text-xs text-accent">…</span>
              ) : (
                <span aria-hidden="true">{position}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleBaseline}
          disabled={isSubmitting}
          className="inline-flex min-h-[44px] items-center justify-center rounded-pill border border-accent/25 bg-accent/10 px-5 py-2.5 text-sm font-medium text-accent transition-colors hover:border-accent/40 hover:bg-accent/20 disabled:opacity-60"
        >
          {status.kind === "submitting" && status.position === "baseline"
            ? "Saving baseline…"
            : "I just set my watch (baseline)"}
        </button>
        <button
          type="button"
          onClick={() => setShowNotes((s) => !s)}
          className="text-xs text-ink-muted transition-colors hover:text-ink"
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
            className="w-full rounded-md border border-line bg-canvas px-3.5 py-2.5 text-sm text-ink shadow-inset-edge outline-none transition-colors placeholder:text-ink-subtle focus:border-ink focus:outline-none focus:ring-2 focus:ring-black/10 disabled:opacity-60"
          />
        </label>
      ) : null}
    </section>
  );
}
