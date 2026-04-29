// Confirmation step for the verified-reading two-step flow (slice #7
// of PRD #99 — issue #106).
//
// Rendered after `POST /readings/verified/draft` returns. The user
// sees their photo + the VLM's predicted MM:SS and either:
//
//   1. Nudges ± seconds (within ±30s) to match what the dial actually
//      reads, then taps Confirm → POSTs /confirm and lands on the
//      watch detail's history pane.
//   2. Taps Retake → returns to the capture step. The draft photo on
//      R2 expires via the 24h lifecycle rule (see
//      `infra/terraform/r2.tf`) so abandoned drafts don't pile up.
//
// ## Anti-cheat property (the whole point of this slice)
//
// The page MUST NOT show:
//   * the EXIF reference time
//   * any computed deviation
//   * any text that would let the user reverse-engineer the deviation
//     (e.g. "+5s ahead", "5s drift")
//
// The hour from the server clock IS shown — but as a small prefix
// ("Reading at 14:") deliberately separated from the prediction
// display, so the brain has to do non-trivial mental arithmetic to
// derive a deviation. The +/- buttons let the user shift seconds
// based on what they see on their watch's dial; they don't know
// what value would yield a "perfect" drift rate, so the dominant
// strategy is honesty.
//
// The E2E test in `tests/e2e/verified-reading-confirmation.smoke.test.ts`
// asserts this with a DOM probe (no element matching
// `[data-testid="deviation"]`, no text matching `/drift|deviation|[+-]\d+s/i`).
//
// ## ±30s adjustment cap
//
// The server enforces ±30s in `/confirm` (slice #6); we mirror it
// client-side via `canAdjust` from `verifiedReadingAdjustment.ts` so
// the buttons disable visually at the limit. UI is convenience;
// server is security.

import { useState } from "react";
import {
  ADJUSTMENT_LIMIT_SECONDS,
  adjustSeconds,
  canAdjust,
  clicksUsed,
  formatMmSs,
  type MmSs,
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
  // The user's working MM:SS — starts at the prediction, mutates as
  // they nudge. Confirm POSTs whatever `current` is at click time.
  const [current, setCurrent] = useState<MmSs>(draft.predicted_mm_ss);
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });

  const used = clicksUsed(draft.predicted_mm_ss, current);
  const canPlus = canAdjust(draft.predicted_mm_ss, current, 1);
  const canMinus = canAdjust(draft.predicted_mm_ss, current, -1);

  function handlePlus() {
    if (!canPlus) return;
    setCurrent((c) => adjustSeconds(c, 1));
  }

  function handleMinus() {
    if (!canMinus) return;
    setCurrent((c) => adjustSeconds(c, -1));
  }

  async function handleConfirm() {
    if (submitState.kind === "submitting") return;
    setSubmitState({ kind: "submitting" });
    const result = await confirmVerifiedReading(watchId, {
      reading_token: draft.reading_token,
      final_mm_ss: current,
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

  // Hour display: rendered in a small "Reading at HH:" prefix above
  // the prediction. Deliberately separated from the MM:SS so the
  // user can't trivially compose hh:mm:ss in their head and compare
  // against the EXIF reference (which they don't have anyway). The
  // hour is always padded to 2 digits to avoid different visual
  // widths between e.g. "9" and "10".
  const hourLabel = String(draft.hour_from_server_clock).padStart(2, "0");

  return (
    <div
      data-testid="verified-reading-confirmation"
      className="flex flex-col gap-5 rounded-md border border-line bg-canvas p-5"
    >
      <header className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-ink">Confirm your reading</h3>
        <p className="text-xs text-ink-muted">
          Adjust if needed, then confirm. The dial reading you submit becomes your
          reading.
        </p>
      </header>

      <img
        data-testid="confirmation-photo"
        src={draft.photo_url}
        alt="Captured dial"
        className="max-h-96 w-full rounded-md border border-line object-contain"
      />

      <div className="flex flex-col items-center gap-1 py-2">
        {/* The "Reading at HH:" prefix sits ABOVE the MM:SS, not
            beside it, so the user's eye doesn't read across as a
            single HH:MM:SS triple. Deliberate UX choice — see the
            anti-cheat note at the top of this file. */}
        <span className="text-xs uppercase tracking-wide text-ink-muted">
          Reading at {hourLabel}:
        </span>
        <div
          data-testid="prediction-mm-ss"
          aria-label={`Reading shows ${formatMmSs(current)}`}
          className="font-mono text-5xl font-light tabular-nums text-ink"
        >
          <span data-testid="confirmation-minutes">
            {String(current.m).padStart(2, "0")}
          </span>
          <span aria-hidden="true" className="mx-1 text-ink-muted">
            :
          </span>
          <span data-testid="confirmation-seconds" className="text-accent">
            {String(current.s).padStart(2, "0")}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-center gap-4">
        <button
          type="button"
          data-testid="confirmation-minus"
          aria-label="Decrease seconds by 1"
          onClick={handleMinus}
          disabled={!canMinus}
          className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-line bg-canvas text-2xl font-light text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          −
        </button>
        <span
          data-testid="confirmation-clicks-used"
          className="font-mono text-xs text-ink-muted"
        >
          ± {used} / {ADJUSTMENT_LIMIT_SECONDS} used
        </span>
        <button
          type="button"
          data-testid="confirmation-plus"
          aria-label="Increase seconds by 1"
          onClick={handlePlus}
          disabled={!canPlus}
          className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-line bg-canvas text-2xl font-light text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          +
        </button>
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
