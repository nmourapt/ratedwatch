// Profile-level corpus-consent toggle (slice #80, PRD #73 User
// Stories #13-#16).
//
// Lets the authenticated user opt in to having their rejected /
// low-confidence dial photos used to improve our dial-reading
// algorithms. Default OFF — privacy-preserving by default. We
// never share photos and we anonymize before any review (PRD User
// Story #13).
//
// State machine:
//   "loading"     while we fetch the initial value from /me
//   "idle"        steady state, the toggle reflects the server value
//   "saving"      mid-PATCH, the toggle is disabled and shows a hint
//   "error"       PATCH failed, we rolled back the toggle and show the message
//
// We intentionally do NOT optimistically update the local state and
// then reconcile — the UX is "flip the switch, watch it confirm" so
// a network failure is honest rather than a silent rollback. The
// indicator shows when a save is in flight.

import { useEffect, useState } from "react";
import { fetchMe, updateMe } from "../auth/api";

type Status =
  | { kind: "loading" }
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "error"; message: string };

export function ConsentCorpusToggle() {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await fetchMe();
        if (cancelled) return;
        setEnabled(me?.consent_corpus === true);
        setStatus({ kind: "idle" });
      } catch {
        if (cancelled) return;
        // Treat fetch failure as "no consent" + visible error so the
        // user knows they didn't accidentally opt in.
        setEnabled(false);
        setStatus({
          kind: "error",
          message: "Couldn't load your settings — please refresh",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleToggle(next: boolean) {
    setStatus({ kind: "saving" });
    const result = await updateMe({ consent_corpus: next });
    if (!result.ok) {
      // Roll back the visible toggle so the UI matches the server.
      setEnabled(!next);
      setStatus({
        kind: "error",
        message: result.error.message,
      });
      return;
    }
    setEnabled(result.user.consent_corpus === true);
    setStatus({ kind: "idle" });
  }

  const isLoading = status.kind === "loading";
  const isSaving = status.kind === "saving";
  const disabled = isLoading || isSaving;

  return (
    <section
      aria-label="Help improve dial reading"
      className="mt-8 flex flex-col gap-3 rounded-lg border border-line bg-surface p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2
            id="consent-corpus-label"
            className="text-sm font-medium tracking-wide text-ink"
          >
            Help improve dial reading
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Allow rated.watch to use your watch photos to improve our dial-reading
            algorithms. We never share your photos, and we anonymize them before any
            review. You can change this at any time.
          </p>
        </div>
        <label className="relative inline-flex shrink-0 items-center self-start">
          <input
            type="checkbox"
            role="switch"
            aria-labelledby="consent-corpus-label"
            data-testid="consent-corpus-toggle"
            checked={enabled}
            disabled={disabled}
            onChange={(event) => {
              void handleToggle(event.target.checked);
            }}
            className="peer h-6 w-11 cursor-pointer appearance-none rounded-full border border-line bg-canvas transition-colors checked:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-surface shadow-sm transition-transform peer-checked:translate-x-5"
          />
        </label>
      </div>
      {status.kind === "saving" ? (
        <p role="status" className="text-xs text-ink-muted">
          Saving…
        </p>
      ) : null}
      {status.kind === "error" ? (
        <p
          role="alert"
          className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink"
        >
          {status.message}
        </p>
      ) : null}
    </section>
  );
}
