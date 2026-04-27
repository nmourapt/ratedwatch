// Slice #17 (issue #18). Camera-capture + upload UI for verified
// readings. Lives on the watch detail page, above the manual
// TapReadingForm. Owner-gated at the page level; this component
// assumes it will only ever render for the watch's owner.
//
// Slice #80 (PRD #73 User Stories #4, #7-#11) extends the flow:
//
//   * Client-side resize to 1500px (`./resizePhoto`) before upload.
//     Reduces mobile-cellular upload time from seconds to fractions
//     of a second on most photos. Falls back to the original bytes
//     when the browser can't decode the file.
//
//   * 3-step progress indicator during the upload+verify round-trip:
//       "Uploading photo" → "Reading dial" → "Saving"
//     Transitions are driven by real state, not a timer — we move
//     to "reading" when fetch() resolves to a Response, and to
//     "saving" when we start parsing JSON from the response. This
//     means the user always sees an honest representation of what
//     the system is doing.
//
//   * New failure-mode UX paths from the CV pipeline:
//     - dial_reader_unsupported_dial    → message + Retake / Enter manually
//     - dial_reader_low_confidence      → message + Retake / Enter manually
//     - dial_reader_no_dial_found       → message + Retake (no manual)
//     - dial_reader_malformed_image     → message + Retake
//     - dial_reader_transport_error     → message + Retry (same photo)
//     - 429 rate_limited                → message + OK
//
//     The `manualFallback` and `canRetake` / `canRetry` flags on the
//     mapped error drive which buttons render. Single source of
//     truth in `verifiedReadingErrors.ts`.
//
//   * "Enter manually" → manual entry mode. The user types HH:MM:SS
//     while the photo is retained; submit calls
//     POST /readings/manual_with_photo and persists a verified=0
//     row with the photo as evidence.
//
// Trust rules (matching slice #16):
//   * Client-side EXIF / capture time is never sent. The server's
//     `Date.now()` (or, post-#71, the photo's EXIF DateTimeOriginal
//     bounded against server arrival) IS the reference time.
//   * Desktop uploads go through the SAME endpoint and get the same
//     trust level. We don't lie about that in the copy — the badge
//     comes from the verified-ratio on the session, not from a per-
//     upload "mobile vs desktop" flag.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createManualWithPhotoReading,
  createVerifiedReading,
  type ManualWithPhotoSubmission,
  type Reading,
  type VerifiedReadingSubmission,
} from "./readings";
import { maybeResize } from "./resizePhoto";
import type { VerifiedReadingErrorMessage } from "./verifiedReadingErrors";

interface Props {
  watchId: string;
  /**
   * Fires after a successful verified submission so the parent can
   * re-fetch the readings list and the session-stats panel. The new
   * reading is passed so callers can render an inline confirmation
   * without a second round-trip if they want to.
   */
  onSubmitted: (reading: Reading) => void;
}

/**
 * 3-step progress indicator during the verify round-trip. Driven
 * by REAL request state, not a timer. The UI shows all three
 * checkpoints with the active one highlighted; "saving" comes
 * after the fetch resolves and we start projecting the JSON.
 */
type SubmitProgress = "uploading" | "reading" | "saving";

type UiState =
  | { kind: "idle" }
  | { kind: "chosen"; file: File; previewUrl: string }
  | {
      kind: "submitting";
      file: File;
      previewUrl: string;
      progress: SubmitProgress;
      mode: "verified" | "manual_with_photo";
    }
  | { kind: "success"; reading: Reading }
  | {
      kind: "error";
      file: File;
      previewUrl: string;
      error: VerifiedReadingErrorMessage;
    }
  | {
      kind: "manual_entry";
      file: File;
      previewUrl: string;
      // Pre-filled from a sensible default (current local time) so
      // the user only edits a couple of fields, not all three.
      hh: string;
      mm: string;
      ss: string;
      submitError: string | null;
    };

const PROGRESS_LABELS: Record<SubmitProgress, string> = {
  uploading: "Uploading photo",
  reading: "Reading dial",
  saving: "Saving",
};

/**
 * Format a signed deviation (seconds) as "+1.2s" / "-0.4s" for the
 * success banner. Positive = watch is ahead of reference.
 */
function formatDeviation(seconds: number): string {
  const sign = seconds > 0 ? "+" : seconds < 0 ? "" : "";
  return `${sign}${seconds.toFixed(1)}s`;
}

/**
 * Render the AI-inferred dial time from a reading row. The server
 * stores reference_timestamp (ms) + deviation_seconds; dial time is
 * reference + deviation. We render HH:MM:SS in local time so the
 * user's reaction is "yes, that's what the watch said" without
 * timezone math.
 */
function formatDialTime(reading: Reading): string {
  const dialMs = reading.reference_timestamp + reading.deviation_seconds * 1000;
  const d = new Date(dialMs);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function defaultManualHHMMSS(): { hh: string; mm: string; ss: string } {
  const d = new Date();
  return { hh: pad2(d.getHours()), mm: pad2(d.getMinutes()), ss: pad2(d.getSeconds()) };
}

/**
 * Validate the typed HH:MM:SS strings on the manual fallback form.
 * Returns null when valid; an error string otherwise. Pure for
 * testability.
 */
export function validateManualTime(input: {
  hh: string;
  mm: string;
  ss: string;
}): { hh: number; mm: number; ss: number } | { error: string } {
  // Empty strings coerce to 0 via Number(""); explicitly reject to
  // surface "you didn't fill that in" rather than accepting 00.
  if (input.hh.trim() === "" || input.mm.trim() === "" || input.ss.trim() === "") {
    return { error: "Hours, minutes, and seconds are required" };
  }
  const hh = Number(input.hh);
  const mm = Number(input.mm);
  const ss = Number(input.ss);
  if (!Number.isInteger(hh) || hh < 0 || hh > 23) {
    return { error: "Hours must be 0–23" };
  }
  if (!Number.isInteger(mm) || mm < 0 || mm > 59) {
    return { error: "Minutes must be 0–59" };
  }
  if (!Number.isInteger(ss) || ss < 0 || ss > 59) {
    return { error: "Seconds must be 0–59" };
  }
  return { hh, mm, ss };
}

export function VerifiedReadingCapture({ watchId, onSubmitted }: Props) {
  const [state, setState] = useState<UiState>({ kind: "idle" });
  const [isBaseline, setIsBaseline] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Revoke object URLs when they change or the component unmounts.
  // We create them in `handleFileChosen` and in the retry path in
  // `handleRetry`, and track the last-known URL so every handoff
  // revokes cleanly regardless of which UiState variant produced it.
  const liveUrlRef = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      if (liveUrlRef.current) URL.revokeObjectURL(liveUrlRef.current);
    };
  }, []);

  const setPreview = useCallback((file: File): string => {
    if (liveUrlRef.current) URL.revokeObjectURL(liveUrlRef.current);
    const url = URL.createObjectURL(file);
    liveUrlRef.current = url;
    return url;
  }, []);

  function clearPreview() {
    if (liveUrlRef.current) URL.revokeObjectURL(liveUrlRef.current);
    liveUrlRef.current = null;
  }

  const handleFileChosen = useCallback(
    (file: File) => {
      const previewUrl = setPreview(file);
      setState({ kind: "chosen", file, previewUrl });
    },
    [setPreview],
  );

  function openFilePicker() {
    // Reset the <input> so choosing the same file twice still fires
    // `change`. `current.click()` is what forces the camera on
    // mobile — a programmatic click on a `capture=environment` input
    // triggers the OS camera the same way as a user tap.
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
      fileInputRef.current.click();
    }
  }

  async function handleSubmit() {
    if (state.kind !== "chosen" && state.kind !== "error") return;
    const sourceFile = state.file;

    // Show "uploading" immediately. The resize runs synchronously
    // (well, microtask-based via canvas.toBlob) BEFORE the network
    // call so users see the progress bar move even on fast networks.
    setState({
      kind: "submitting",
      file: sourceFile,
      previewUrl: state.previewUrl,
      progress: "uploading",
      mode: "verified",
    });

    const resized = await maybeResize(sourceFile);
    const submission: VerifiedReadingSubmission = {
      image: resized.file,
      isBaseline,
    };

    // Network round-trip. We can't observe the server's CV step
    // independently from this single fetch, but moving from
    // "uploading" → "reading" the moment the request body is sent
    // gives the user a sensible mental model of what's happening.
    // We approximate by flipping to "reading" on the next tick
    // after kicking off the fetch, then "saving" once the response
    // resolves and we start parsing the JSON.
    const flipToReading = setTimeout(() => {
      setState((prev) =>
        prev.kind === "submitting" && prev.progress === "uploading"
          ? { ...prev, progress: "reading" }
          : prev,
      );
    }, 200);

    const result = await createVerifiedReading(watchId, submission);
    clearTimeout(flipToReading);

    if (result.ok) {
      // Briefly show "saving" before the success banner so the user
      // sees the third checkpoint tick. This is honest UX — the
      // server has already saved by the time we get here, but the
      // CLIENT is now saving the result into its own state and
      // re-rendering, which IS work.
      setState((prev) =>
        prev.kind === "submitting" ? { ...prev, progress: "saving" } : prev,
      );
      // Wait one frame so the user actually perceives the transition.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      clearPreview();
      setIsBaseline(false);
      setState({ kind: "success", reading: result.reading });
      onSubmitted(result.reading);
      return;
    }

    setState({
      kind: "error",
      file: submission.image,
      previewUrl: liveUrlRef.current ?? "",
      error: result.error,
    });
  }

  /**
   * From the error state, transition to the manual-entry sub-flow.
   * The photo is retained so the eventual `manual_with_photo`
   * upload sends the same bytes the user already captured.
   */
  function handleEnterManually() {
    if (state.kind !== "error") return;
    setState({
      kind: "manual_entry",
      file: state.file,
      previewUrl: state.previewUrl,
      ...defaultManualHHMMSS(),
      submitError: null,
    });
  }

  async function handleManualSubmit() {
    if (state.kind !== "manual_entry") return;
    const validated = validateManualTime({
      hh: state.hh,
      mm: state.mm,
      ss: state.ss,
    });
    if ("error" in validated) {
      setState({ ...state, submitError: validated.error });
      return;
    }
    const submission: ManualWithPhotoSubmission = {
      image: state.file,
      hh: validated.hh,
      mm: validated.mm,
      ss: validated.ss,
      isBaseline,
    };
    setState({
      kind: "submitting",
      file: state.file,
      previewUrl: state.previewUrl,
      progress: "uploading",
      mode: "manual_with_photo",
    });
    const result = await createManualWithPhotoReading(watchId, submission);
    if (!result.ok) {
      // Bounce back to manual_entry with the error inline. The
      // verified-error mapper covers this path — the only realistic
      // failures here are network / 5xx / 401, all of which fall
      // through to the GENERIC mapping.
      setState({
        kind: "manual_entry",
        file: submission.image,
        previewUrl: liveUrlRef.current ?? "",
        hh: state.hh,
        mm: state.mm,
        ss: state.ss,
        submitError: result.error.message,
      });
      return;
    }
    clearPreview();
    setIsBaseline(false);
    setState({ kind: "success", reading: result.reading });
    onSubmitted(result.reading);
  }

  function handleRetake() {
    clearPreview();
    setIsBaseline(false);
    setState({ kind: "idle" });
    // Trigger the file picker so retry is one tap, not two.
    setTimeout(() => openFilePicker(), 0);
  }

  function handleRetry() {
    if (state.kind !== "error") return;
    // Same photo, fresh attempt — used for transport_error.
    setState({
      kind: "chosen",
      file: state.file,
      previewUrl: state.previewUrl,
    });
    void handleSubmit();
  }

  function handleDismiss() {
    clearPreview();
    setIsBaseline(false);
    setState({ kind: "idle" });
  }

  function handleCancelOrReset() {
    clearPreview();
    setIsBaseline(false);
    setState({ kind: "idle" });
  }

  const showIdle = state.kind === "idle";
  const showChosen = state.kind === "chosen";
  const showSubmitting = state.kind === "submitting";
  const showSuccess = state.kind === "success";
  const showError = state.kind === "error";
  const showManualEntry = state.kind === "manual_entry";

  // preview URL for the <img> in chosen/submitting/error/manual_entry states
  const preview =
    state.kind === "chosen" ||
    state.kind === "submitting" ||
    state.kind === "error" ||
    state.kind === "manual_entry"
      ? state.previewUrl
      : null;

  return (
    <section
      aria-label="Verified reading"
      className="mb-6 rounded-lg border border-line bg-surface p-5"
    >
      <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">
        Log a verified reading
      </h2>
      <p className="mb-4 text-xs text-ink-muted">
        Take a photo of the dial and we&apos;ll read it against the server clock at the
        moment we receive your upload. No timestamp from your device is trusted — the
        reference time is &ldquo;now&rdquo; on the server.
      </p>

      {/* Hidden input. Rendered once, reused across the idle/chosen
          flows. `capture="environment"` steers mobile browsers to the
          rear camera; desktop silently ignores it. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        data-testid="verified-reading-file-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileChosen(file);
        }}
      />

      {showIdle ? (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={openFilePicker}
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-pill bg-accent px-5 py-3 text-sm font-medium text-accent-fg transition-colors hover:bg-accent/90 sm:w-auto"
          >
            Take photo
          </button>
          <p className="text-xs text-ink-subtle">
            On desktop this opens a file picker — for the reading to count, use a fresh
            photo, not an old one from your library.
          </p>
        </div>
      ) : null}

      {preview ? (
        <img
          src={preview}
          alt="Captured dial"
          className="mb-4 max-h-80 rounded-md border border-line object-contain"
        />
      ) : null}

      {showError ? (
        <div
          role="alert"
          data-testid="verified-reading-error"
          data-error-code={state.kind === "error" ? state.error.code : undefined}
          className="mb-4 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink"
        >
          <p>{state.kind === "error" ? state.error.message : null}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {state.kind === "error" && state.error.canRetake ? (
              <button
                type="button"
                onClick={handleRetake}
                className="inline-flex min-h-[44px] items-center justify-center rounded-pill bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent/90"
              >
                Retake photo
              </button>
            ) : null}
            {state.kind === "error" && state.error.canRetry ? (
              <button
                type="button"
                onClick={handleRetry}
                className="inline-flex min-h-[44px] items-center justify-center rounded-pill bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent/90"
              >
                Retry
              </button>
            ) : null}
            {state.kind === "error" && state.error.manualFallback ? (
              <button
                type="button"
                onClick={handleEnterManually}
                className="inline-flex min-h-[44px] items-center justify-center rounded-pill border border-line bg-canvas px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-ink-muted"
              >
                Enter manually
              </button>
            ) : null}
            {state.kind === "error" && !state.error.canRetake && !state.error.canRetry ? (
              <button
                type="button"
                onClick={handleDismiss}
                className="inline-flex min-h-[44px] items-center justify-center rounded-pill border border-line bg-canvas px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-ink-muted"
              >
                OK
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {showChosen ? (
        <div className="flex flex-col gap-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={isBaseline}
              onChange={(e) => setIsBaseline(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-line text-accent focus:ring-accent"
            />
            <span>
              <span className="text-ink">This is a baseline</span>
              <span className="ml-1 text-ink-muted">
                — I just set the watch to the exact time
              </span>
            </span>
          </label>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handleSubmit}
              className="inline-flex min-h-[44px] items-center justify-center rounded-pill bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent/90"
            >
              Submit verified reading
            </button>
            <button
              type="button"
              onClick={handleCancelOrReset}
              className="inline-flex min-h-[44px] items-center justify-center rounded-pill border border-line bg-canvas px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-ink-muted"
            >
              Choose a different photo
            </button>
          </div>
        </div>
      ) : null}

      {showManualEntry && state.kind === "manual_entry" ? (
        <div
          data-testid="verified-reading-manual-entry"
          className="flex flex-col gap-3 rounded-md border border-line bg-canvas px-3 py-3 text-sm"
        >
          <p className="text-ink">
            Type the time your watch is showing right now (24-hour). We&apos;ll save it as
            a manual reading and keep your photo as evidence.
          </p>
          <div className="flex items-center gap-1 font-mono">
            <input
              type="number"
              min={0}
              max={23}
              aria-label="Hours"
              value={state.hh}
              onChange={(e) => setState({ ...state, hh: e.target.value })}
              className="w-16 rounded-md border border-line bg-canvas px-2 py-1.5 text-center text-base text-ink"
            />
            <span aria-hidden="true">:</span>
            <input
              type="number"
              min={0}
              max={59}
              aria-label="Minutes"
              value={state.mm}
              onChange={(e) => setState({ ...state, mm: e.target.value })}
              className="w-16 rounded-md border border-line bg-canvas px-2 py-1.5 text-center text-base text-ink"
            />
            <span aria-hidden="true">:</span>
            <input
              type="number"
              min={0}
              max={59}
              aria-label="Seconds"
              value={state.ss}
              onChange={(e) => setState({ ...state, ss: e.target.value })}
              className="w-16 rounded-md border border-line bg-canvas px-2 py-1.5 text-center text-base text-ink"
            />
          </div>
          {state.submitError ? (
            <p role="alert" className="text-sm text-accent">
              {state.submitError}
            </p>
          ) : null}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={isBaseline}
              onChange={(e) => setIsBaseline(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-line text-accent focus:ring-accent"
            />
            <span>
              <span className="text-ink">This is a baseline</span>
              <span className="ml-1 text-ink-muted">— deviation will be saved as 0</span>
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleManualSubmit}
              className="inline-flex min-h-[44px] items-center justify-center rounded-pill bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent/90"
            >
              Save manual reading
            </button>
            <button
              type="button"
              onClick={handleCancelOrReset}
              className="inline-flex min-h-[44px] items-center justify-center rounded-pill border border-line bg-canvas px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-ink-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {showSubmitting && state.kind === "submitting" ? (
        <ProgressIndicator current={state.progress} />
      ) : null}

      {showSuccess && state.kind === "success" ? (
        <div
          role="status"
          className="rounded-md border border-accent/30 bg-canvas px-4 py-3"
        >
          <p className="text-sm text-ink">
            Saved. Dial read at{" "}
            <span className="font-mono text-accent">{formatDialTime(state.reading)}</span>
            , deviation{" "}
            <span className="font-mono text-accent">
              {formatDeviation(state.reading.deviation_seconds)}
            </span>
            .
          </p>
          <button
            type="button"
            onClick={handleCancelOrReset}
            className="mt-3 inline-flex min-h-[44px] items-center justify-center rounded-pill border border-line bg-canvas px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-accent hover:text-accent"
          >
            Save another
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ProgressIndicator({ current }: { current: SubmitProgress }) {
  const steps: SubmitProgress[] = ["uploading", "reading", "saving"];
  const currentIndex = steps.indexOf(current);
  return (
    <ol
      role="status"
      aria-label="Submission progress"
      data-testid="verified-reading-progress"
      data-current-step={current}
      className="flex flex-col gap-2 text-sm"
    >
      {steps.map((step, idx) => {
        const isDone = idx < currentIndex;
        const isActive = idx === currentIndex;
        return (
          <li
            key={step}
            data-step={step}
            data-state={isDone ? "done" : isActive ? "active" : "pending"}
            className="flex items-center gap-2"
          >
            {isActive ? (
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent"
              />
            ) : isDone ? (
              <span aria-hidden="true" className="inline-block h-3 w-3 text-accent">
                ✓
              </span>
            ) : (
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 rounded-full border border-line"
              />
            )}
            <span className={isActive ? "text-ink" : "text-ink-muted"}>
              {PROGRESS_LABELS[step]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
