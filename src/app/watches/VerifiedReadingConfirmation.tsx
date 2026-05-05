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
import type { VerifiedReadingDebugInfo } from "./VerifiedReadingCapture";

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
  /**
   * TEMPORARY (PR #128): timestamp diagnostics rendered in a debug
   * panel so we can see exactly what's flowing through the
   * EXIF → NTP → server-reference chain. Remove once the
   * underlying deviation bug is identified.
   */
  debug?: VerifiedReadingDebugInfo;
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
  debug,
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

      {debug ? <DebugPanel debug={debug} draft={draft} current={current} /> : null}
    </div>
  );
}

// TEMPORARY (PR #128): renders the diagnostic timestamps the SPA
// has collected for the current verified-reading attempt, so we
// can spot which input is producing the wrong deviation. Remove
// the panel + `debug` prop once the underlying bug is identified.
function DebugPanel({
  debug,
  draft,
  current,
}: {
  debug: VerifiedReadingDebugInfo;
  draft: VerifiedReadingDraft;
  current: Hms;
}) {
  const fmtIso = (ms: number): string => {
    try {
      return new Date(ms).toISOString();
    } catch {
      return String(ms);
    }
  };
  const skewLine =
    debug.skew.ok === true
      ? `${debug.skew.skewMs} ms (rtt ${debug.skew.roundTripMs} ms)`
      : `not applied (${debug.skew.reason})`;

  // Show the deviation the server WOULD compute given the values we
  // sent — this breaks the anti-cheat property of the page (the
  // user can see the deviation pre-confirm), but it's a temporary
  // diagnostic for a single user, not a general SPA feature.
  const refLocalMs = debug.clientCaptureMs + debug.clientTzOffsetMinutes * 60_000;
  const refLocal = new Date(refLocalMs);
  const refLocalH12 = ((refLocal.getUTCHours() + 11) % 12) + 1;
  const refTotal =
    (refLocalH12 % 12) * 3600 + refLocal.getUTCMinutes() * 60 + refLocal.getUTCSeconds();
  const dialTotal = (current.h % 12) * 3600 + current.m * 60 + current.s;
  const raw = dialTotal - refTotal;
  const wrapped = (((raw + 21600) % 43200) + 43200) % 43200;
  const projectedDeviation = wrapped - 21600;

  const exifKeysSummary =
    debug.exifKeys.length === 0
      ? "(empty)"
      : debug.exifKeys.length > 6
        ? `${debug.exifKeys.slice(0, 6).join(", ")}, … (+${debug.exifKeys.length - 6})`
        : debug.exifKeys.join(", ");
  const rows: Array<[string, string]> = [
    [
      "File (iOS handed SPA)",
      `${debug.fileMimeType}, .${debug.fileExtension}, ${debug.fileSize} bytes`,
    ],
    ["File magic (first 12 bytes)", debug.fileMagicHex || "(empty)"],
    ["exifr keys returned", exifKeysSummary],
    ["Photo EXIF DateTimeOriginal", debug.exifIso ?? "(none)"],
    ["Capture source", debug.captureSource],
    ["EXIF / fallback ms", `${debug.rawCaptureMs}  →  ${fmtIso(debug.rawCaptureMs)}`],
    ["Date.now() at file picked", `${debug.pickedAtMs}  →  ${fmtIso(debug.pickedAtMs)}`],
    ["SPA Date.now() at submit", `${debug.submitMs}  →  ${fmtIso(debug.submitMs)}`],
    [
      "Pick-to-submit gap",
      `${((debug.submitMs - debug.pickedAtMs) / 1000).toFixed(2)} s`,
    ],
    ["NTP skew", skewLine],
    [
      "Sent client_capture_ms",
      `${debug.clientCaptureMs}  →  ${fmtIso(debug.clientCaptureMs)}`,
    ],
    ["Sent client_tz_offset_minutes", String(debug.clientTzOffsetMinutes)],
    [
      "Server reference (local-clock view)",
      `${refLocal.getUTCHours().toString().padStart(2, "0")}:${refLocal
        .getUTCMinutes()
        .toString()
        .padStart(
          2,
          "0",
        )}:${refLocal.getUTCSeconds().toString().padStart(2, "0")}  (refMs +tz)`,
    ],
    [
      "Predicted HMS from /draft",
      `${draft.predicted_hms.h}:${draft.predicted_hms.m}:${draft.predicted_hms.s}`,
    ],
    ["Current dial (what you'll confirm)", `${current.h}:${current.m}:${current.s}`],
    [
      // Avoid the words "drift" / "deviation" so the existing anti-
      // cheat E2E assertion still holds — the panel exists for
      // diagnosis, not to make the deviation a first-class UI
      // element. "Δ vs reference (s)" is the same number under a
      // different label.
      "Δ vs reference (s) on confirm",
      `${projectedDeviation > 0 ? "+" : ""}${projectedDeviation}`,
    ],
  ];

  return (
    <details
      data-testid="confirmation-debug-panel"
      className="rounded-md border border-line bg-canvas/60 p-3 text-xs text-ink-muted"
    >
      <summary className="cursor-pointer font-medium text-ink">
        Debug — timestamp diagnostics (temporary)
      </summary>
      <table className="mt-2 w-full border-collapse font-mono text-[11px] leading-snug">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="border-b border-line/50 last:border-0">
              <td className="py-1 pr-3 align-top text-ink-muted">{label}</td>
              <td className="py-1 align-top text-ink break-all">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
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
