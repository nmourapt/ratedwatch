// Confirmation step for the verified-reading two-step flow (slice
// #7 of PRD #99 — issue #106). Reworked in PR #122 to:
//
//   1. Render full HH:MM:SS in a single row at large size, with
//      independent up/down adjusters under each component (matches
//      the user's mental model: "set each digit to what your
//      watch shows").
//
//   2. Drop the ±30s seconds-only adjustment cap. The cap was
//      always more about UI nudge than fraud prevention — a
//      determined cheater knows the rough current time from their
//      phone clock and can game the value either direction. The
//      photo audit trail and the rate-limit are the real
//      defences.
//
//   3. Use the new `predicted_hms` from /draft (replacing
//      `predicted_mm_ss` + `hour_from_server_clock` returned
//      separately).
//
// ## Anti-cheat property (the whole point of this slice)
//
// The page MUST NOT show:
//   * the EXIF reference time
//   * any computed deviation
//   * any text that would let the user reverse-engineer the
//     deviation (e.g. "+5s ahead", "5s drift")
//
// Showing the full HH:MM:SS doesn't violate this — the user
// already knows the rough current time from their phone clock,
// so showing the system's read of their watch doesn't leak the
// (server-internal) deviation. The E2E test in
// `tests/e2e/verified-reading-confirmation.smoke.test.ts` asserts
// no `[data-testid="deviation"]` and no text matching
// `/drift|deviation|[+-]\d+s/i` — both still hold under the new
// layout.

import { useState } from "react";
import {
  adjustComponent,
  type Hms,
  type HmsComponent,
} from "./verifiedReadingAdjustment";
import {
  confirmVerifiedReading,
  type Reading,
  type VerifiedReadingDraft,
} from "./readings";
import type { VerifiedReadingErrorMessage } from "./verifiedReadingErrors";

interface Props {
  watchId: string;
  draft: VerifiedReadingDraft;
  isBaseline: boolean;
  /**
   * Bubble up to the parent so the watch detail page can re-render
   * the readings list + session stats. The parent is also responsible
   * for clearing the draft state once the reading is saved.
   */
  onConfirmed: (reading: Reading) => void;
  /**
   * Bubble up so the parent can return to the capture step. The
   * draft photo's R2 lifecycle rule cleans up abandoned drafts.
   */
  onRetake: () => void;
}

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; error: VerifiedReadingErrorMessage };

export function VerifiedReadingConfirmation({
  watchId,
  draft,
  isBaseline,
  onConfirmed,
  onRetake,
}: Props) {
  // The user's working HMS — starts at the prediction, mutates per
  // component as they tap up/down. Confirm POSTs whatever `current`
  // is at click time.
  const [current, setCurrent] = useState<Hms>(draft.predicted_hms);
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });

  function handleAdjust(component: HmsComponent, delta: 1 | -1) {
    setCurrent((c) => adjustComponent(c, component, delta));
  }

  async function handleConfirm() {
    if (submitState.kind === "submitting") return;
    setSubmitState({ kind: "submitting" });
    const result = await confirmVerifiedReading(watchId, {
      reading_token: draft.reading_token,
      final_hms: current,
      is_baseline: isBaseline,
    });
    if (!result.ok) {
      setSubmitState({ kind: "error", error: result.error });
      return;
    }
    // Clear local error / submit state isn't necessary — the parent
    // unmounts us once the reading is saved.
    onConfirmed(result.reading);
  }

  return (
    <div
      data-testid="verified-reading-confirmation"
      className="flex flex-col gap-5 rounded-md border border-line bg-canvas p-5"
    >
      <header className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-ink">Confirm your reading</h3>
        <p className="text-xs text-ink-muted">
          Adjust each value to match what your dial shows, then confirm.
        </p>
      </header>

      <img
        data-testid="confirmation-photo"
        src={draft.photo_url}
        alt="Captured dial"
        className="max-h-96 w-full rounded-md border border-line object-contain"
      />

      {/* Big HH:MM:SS row with up/down arrows beneath each
          component. We render each {▲, NN, ▼} as a column so the
          buttons line up directly under the digit they affect. */}
      <div
        data-testid="prediction-hh-mm-ss"
        aria-label={`Reading shows ${formatHmsLabel(current)}`}
        className="flex flex-col items-center gap-2 py-2"
      >
        <div className="flex items-center justify-center gap-2 font-mono text-5xl font-light tabular-nums text-ink">
          <HmsColumn
            component="h"
            value={current.h}
            label="hour"
            testId="confirmation-hours"
            onAdjust={handleAdjust}
          />
          <span aria-hidden="true" className="self-center text-ink-muted">
            :
          </span>
          <HmsColumn
            component="m"
            value={current.m}
            label="minute"
            testId="confirmation-minutes"
            onAdjust={handleAdjust}
          />
          <span aria-hidden="true" className="self-center text-ink-muted">
            :
          </span>
          <HmsColumn
            component="s"
            value={current.s}
            label="second"
            testId="confirmation-seconds"
            onAdjust={handleAdjust}
          />
        </div>
        <span className="text-xs uppercase tracking-wide text-ink-muted">
          {/* Plain English caption — orients the user without
              giving away any deviation hint. Doesn't match the
              anti-cheat regex /drift|deviation|[+-]\d+s/i. */}
          Tap ▲ or ▼ under each digit to match your dial
        </span>
      </div>

      {submitState.kind === "error" ? (
        <div
          role="alert"
          data-testid="confirmation-error"
          data-error-code={submitState.error.code}
          className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink"
        >
          {submitState.error.message}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          data-testid="confirmation-confirm"
          onClick={handleConfirm}
          disabled={submitState.kind === "submitting"}
          className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-pill bg-accent px-5 py-3 text-sm font-medium text-accent-fg transition-colors hover:bg-accent/90 disabled:opacity-60"
        >
          {submitState.kind === "submitting" ? "Saving…" : "Confirm reading"}
        </button>
        <button
          type="button"
          data-testid="confirmation-retake"
          onClick={onRetake}
          disabled={submitState.kind === "submitting"}
          className="inline-flex min-h-[44px] items-center justify-center rounded-pill border border-line bg-canvas px-5 py-3 text-sm font-medium text-ink transition-colors hover:border-ink-muted disabled:opacity-60"
        >
          Retake photo
        </button>
      </div>
    </div>
  );
}

interface HmsColumnProps {
  component: HmsComponent;
  value: number;
  /** Plural label for a11y ("hour" / "minute" / "second"). */
  label: string;
  /** Test ID applied to the digit element so E2E can assert text. */
  testId: string;
  onAdjust: (component: HmsComponent, delta: 1 | -1) => void;
}

/**
 * One column of the HH:MM:SS row: ▲ on top, the two-digit value in
 * the middle, ▼ on the bottom. Each button is a 36×28 tap target
 * — slightly tighter than the 44×44 a11y minimum, but the column
 * grid wraps the digit in the middle so the entire column is a
 * comfortable thumb zone on mobile. The accent colour denotes
 * "this is the user-actionable part" — same convention as the
 * pre-PR-#122 design's seconds-only highlighting.
 */
function HmsColumn({ component, value, label, testId, onAdjust }: HmsColumnProps) {
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        data-testid={`${testId}-up`}
        aria-label={`Increase ${label} by 1`}
        onClick={() => onAdjust(component, 1)}
        className="inline-flex h-9 w-12 items-center justify-center rounded-md border border-line bg-canvas text-sm text-ink transition-colors hover:border-accent hover:text-accent"
      >
        ▲
      </button>
      <span data-testid={testId} className="text-accent">
        {String(value).padStart(2, "0")}
      </span>
      <button
        type="button"
        data-testid={`${testId}-down`}
        aria-label={`Decrease ${label} by 1`}
        onClick={() => onAdjust(component, -1)}
        className="inline-flex h-9 w-12 items-center justify-center rounded-md border border-line bg-canvas text-sm text-ink transition-colors hover:border-accent hover:text-accent"
      >
        ▼
      </button>
    </div>
  );
}

function formatHmsLabel(hms: Hms): string {
  return `${String(hms.h).padStart(2, "0")}:${String(hms.m).padStart(2, "0")}:${String(hms.s).padStart(2, "0")}`;
}
