// Slice #17 (issue #18). Camera-capture + upload UI for verified
// readings. Lives on the watch detail page, above the manual
// LogReadingForm. Owner-gated at the page level; this component
// assumes it will only ever render for the watch's owner.
//
// UX flow:
//
//   1. No file yet → big "Take photo" button. On mobile the <input>
//      has `capture="environment"` so tapping it opens the rear
//      camera directly (iOS 10+ / Chrome for Android). On desktop
//      the same input behaves as a file picker, and we surface a
//      line of copy explaining that a fresh photo is still required
//      for the reading to count.
//   2. File chosen → preview via URL.createObjectURL + a checkbox
//      for baseline ("I just set the watch") + "Submit verified
//      reading" / "Choose a different photo" buttons.
//   3. Submitting → spinner. A single-line note tells the user the
//      server stamps the reference time at RECEIPT, not capture, so
//      they're not surprised by the ~1s latency.
//   4. Success → show the AI-read dial time, the computed deviation,
//      and a "Save another" button that resets to state (1).
//   5. Error → human copy from verifiedReadingErrors.ts + a "Try
//      again" button that keeps the same file (you probably want to
//      resubmit, not re-capture, if the error was transient).
//
// Trust rules (matching slice #16):
//   * Client-side EXIF / capture time is never sent. The server's
//     `Date.now()` at request receipt IS the reference time.
//   * Desktop uploads go through the SAME endpoint and get the same
//     trust level. We don't lie about that in the copy — the badge
//     comes from the verified-ratio on the session, not from a per-
//     upload "mobile vs desktop" flag.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createVerifiedReading,
  type Reading,
  type VerifiedReadingSubmission,
} from "./readings";

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

type UiState =
  | { kind: "idle" }
  | { kind: "chosen"; file: File; previewUrl: string }
  | { kind: "submitting"; file: File; previewUrl: string }
  | { kind: "success"; reading: Reading }
  | {
      kind: "error";
      file: File;
      previewUrl: string;
      message: string;
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
    // Guard against double-clicks; also appeases the type narrowing
    // below since we only have a file in the chosen/error states.
    if (state.kind !== "chosen" && state.kind !== "error") return;
    const submission: VerifiedReadingSubmission = {
      image: state.file,
      isBaseline,
    };
    setState({
      kind: "submitting",
      file: state.file,
      previewUrl: state.previewUrl,
    });
    const result = await createVerifiedReading(watchId, submission);
    if (!result.ok) {
      // Keep the file + preview so the user can retry without re-
      // capturing. Swap UiState so the error banner renders.
      setState({
        kind: "error",
        file: submission.image,
        previewUrl: liveUrlRef.current ?? "",
        message: result.error.message,
      });
      return;
    }
    // Wipe the preview on success — the next "Save another" tap
    // starts from a fresh camera.
    clearPreview();
    setIsBaseline(false);
    setState({ kind: "success", reading: result.reading });
    onSubmitted(result.reading);
  }

  function handleCancelOrReset() {
    clearPreview();
    setIsBaseline(false);
    setState({ kind: "idle" });
  }

  const showIdle = state.kind === "idle";
  const showChosen = state.kind === "chosen" || state.kind === "error";
  const showSubmitting = state.kind === "submitting";
  const showSuccess = state.kind === "success";

  // preview URL for the <img> in chosen/submitting/error states
  const preview =
    state.kind === "chosen" || state.kind === "submitting" || state.kind === "error"
      ? state.previewUrl
      : null;

  return (
    <section
      aria-label="Verified reading"
      className="mb-6 rounded-lg border border-cf-border bg-cf-bg-200 p-5"
    >
      <h2 className="mb-1 text-sm font-medium text-cf-text">Log a verified reading</h2>
      <p className="mb-4 text-xs text-cf-text-muted">
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
            className="inline-flex w-full items-center justify-center rounded-full border border-cf-orange bg-cf-orange px-5 py-3 text-sm font-medium text-cf-bg-100 transition-colors hover:bg-cf-orange/90 sm:w-auto"
          >
            Take photo
          </button>
          <p className="text-xs text-cf-text-subtle">
            On desktop this opens a file picker — for the reading to count, use a fresh
            photo, not an old one from your library.
          </p>
        </div>
      ) : null}

      {preview ? (
        <img
          src={preview}
          alt="Captured dial"
          className="mb-4 max-h-80 rounded-md border border-cf-border object-contain"
        />
      ) : null}

      {state.kind === "error" ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-cf-orange/40 bg-cf-orange/10 px-3 py-2 text-sm text-cf-text"
        >
          {state.message}
        </p>
      ) : null}

      {showChosen ? (
        <div className="flex flex-col gap-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={isBaseline}
              onChange={(e) => setIsBaseline(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-cf-border text-cf-orange focus:ring-cf-orange"
            />
            <span>
              <span className="text-cf-text">This is a baseline</span>
              <span className="ml-1 text-cf-text-muted">
                — I just set the watch to the exact time
              </span>
            </span>
          </label>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handleSubmit}
              className="inline-flex items-center justify-center rounded-full border border-cf-orange bg-cf-orange px-5 py-2.5 text-sm font-medium text-cf-bg-100 transition-colors hover:bg-cf-orange/90"
            >
              Submit verified reading
            </button>
            <button
              type="button"
              onClick={handleCancelOrReset}
              className="inline-flex items-center justify-center rounded-full border border-cf-border bg-transparent px-5 py-2.5 text-sm font-medium text-cf-text transition-colors hover:border-cf-text-muted"
            >
              Choose a different photo
            </button>
          </div>
        </div>
      ) : null}

      {showSubmitting ? (
        <p className="flex items-center gap-2 text-sm text-cf-text-muted">
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-cf-orange border-t-transparent"
          />
          Reading the dial…
        </p>
      ) : null}

      {showSuccess ? (
        <div
          role="status"
          className="rounded-md border border-cf-orange/30 bg-cf-bg-100 px-4 py-3"
        >
          <p className="text-sm text-cf-text">
            Saved. Dial read at{" "}
            <span className="font-mono text-cf-orange">
              {formatDialTime(state.reading)}
            </span>
            , deviation{" "}
            <span className="font-mono text-cf-orange">
              {formatDeviation(state.reading.deviation_seconds)}
            </span>
            .
          </p>
          <button
            type="button"
            onClick={handleCancelOrReset}
            className="mt-3 inline-flex items-center justify-center rounded-full border border-cf-border bg-transparent px-4 py-2 text-sm font-medium text-cf-text transition-colors hover:border-cf-orange hover:text-cf-orange"
          >
            Save another
          </button>
        </div>
      ) : null}
    </section>
  );
}
