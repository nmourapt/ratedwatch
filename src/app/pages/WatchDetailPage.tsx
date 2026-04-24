// Detail view of a single watch. Read-only metadata at the top,
// then — slice #13 — session stats, a "log a reading" form, and the
// reading log itself. Delete-watch still lives at the bottom.
//
// The readings section fetches in parallel with the watch lookup so
// the page doesn't need two sequential round-trips to render. Every
// mutation (log, delete) calls `reloadReadings()` to re-pull both
// the list and the server-computed session stats.

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ReadingList } from "../watches/ReadingList";
import { TapReadingForm } from "../watches/TapReadingForm";
import { SessionStatsPanel } from "../watches/SessionStatsPanel";
import { VerifiedProgressRing } from "../watches/VerifiedProgressRing";
import { VerifiedReadingCapture } from "../watches/VerifiedReadingCapture";
import { WatchPhotoPanel } from "../watches/WatchPhotoPanel";
import { deleteWatch, getWatch, updateWatch, type Watch } from "../watches/api";
import { listReadings, type Reading, type SessionStats } from "../watches/readings";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; watch: Watch }
  | { kind: "error"; message: string };

interface ReadingsState {
  readings: Reading[];
  session_stats: SessionStats | null;
  error: string | null;
  loading: boolean;
}

const EMPTY_READINGS_STATE: ReadingsState = {
  readings: [],
  session_stats: null,
  error: null,
  loading: true,
};

export function WatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [readings, setReadings] = useState<ReadingsState>(EMPTY_READINGS_STATE);
  const [deleting, setDeleting] = useState(false);
  // Visibility toggle (slice #11). Kept local so we can show an inline
  // saving/error state without re-fetching the whole watch record.
  const [togglingVisibility, setTogglingVisibility] = useState(false);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);

  const reloadReadings = useCallback(async () => {
    if (!id) return;
    setReadings((prev) => ({ ...prev, loading: true }));
    const result = await listReadings(id);
    if (result.ok) {
      setReadings({
        readings: result.readings,
        session_stats: result.session_stats,
        error: null,
        loading: false,
      });
    } else {
      setReadings({
        readings: [],
        session_stats: null,
        error: result.error.message,
        loading: false,
      });
    }
  }, [id]);

  const reloadWatch = useCallback(async () => {
    if (!id) return;
    const result = await getWatch(id);
    if (result.ok) {
      setState({ kind: "loaded", watch: result.watch });
    } else {
      setState({ kind: "error", message: result.error.message });
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const result = await getWatch(id);
      if (cancelled) return;
      if (result.ok) {
        setState({ kind: "loaded", watch: result.watch });
      } else {
        setState({ kind: "error", message: result.error.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    // Don't wait on the watch lookup — fetch readings in parallel.
    // Errors are stored in-panel, not propagated to the whole page.
    void reloadReadings();
  }, [id, reloadReadings]);

  async function handleDelete() {
    if (!id) return;
    if (!window.confirm("Delete this watch? This cannot be undone.")) return;
    setDeleting(true);
    const result = await deleteWatch(id);
    setDeleting(false);
    if (!result.ok) {
      setState({ kind: "error", message: result.error.message });
      return;
    }
    navigate("/app/dashboard", { replace: true });
  }

  async function handleToggleVisibility() {
    if (!id || state.kind !== "loaded") return;
    const next = !state.watch.is_public;
    setTogglingVisibility(true);
    setVisibilityError(null);
    const result = await updateWatch(id, { is_public: next });
    setTogglingVisibility(false);
    if (!result.ok) {
      setVisibilityError(result.error.message);
      return;
    }
    setState({ kind: "loaded", watch: result.watch });
  }

  if (state.kind === "loading") {
    return (
      <section className="mx-auto max-w-2xl">
        <p className="font-mono text-sm text-ink-subtle">Loading watch…</p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section className="mx-auto max-w-2xl">
        <p
          role="alert"
          className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink"
        >
          {state.message}
        </p>
        <Link
          to="/app/dashboard"
          className="mt-4 inline-block text-sm text-accent hover:underline"
        >
          ← Back to dashboard
        </Link>
      </section>
    );
  }

  const { watch } = state;
  const movementLabel = watch.movement_canonical_name
    ? watch.movement_canonical_name
    : watch.custom_movement_name
      ? `Custom: ${watch.custom_movement_name}`
      : "—";

  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="mb-1 text-4xl font-medium tracking-tight text-ink">
            {watch.name}
          </h1>
          <p className="text-ink-muted">
            {watch.brand || watch.model
              ? [watch.brand, watch.model].filter(Boolean).join(" ")
              : "No brand/model set"}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={watch.is_public}
            aria-label="Public on leaderboards"
            onClick={handleToggleVisibility}
            disabled={togglingVisibility}
            className={
              watch.is_public
                ? "inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-ink-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
                : "inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-60"
            }
          >
            <span
              aria-hidden="true"
              className={
                watch.is_public
                  ? "inline-block h-2 w-2 rounded-full bg-ink-muted"
                  : "inline-block h-2 w-2 rounded-full bg-accent"
              }
            />
            {togglingVisibility
              ? "Saving…"
              : watch.is_public
                ? "Public on leaderboards"
                : "Private"}
          </button>
          {visibilityError ? (
            <p role="alert" className="text-xs text-accent">
              {visibilityError}
            </p>
          ) : null}
        </div>
      </div>

      <dl className="mb-8 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[140px_1fr]">
        <dt className="text-sm font-medium text-ink-muted">Movement</dt>
        <dd className="text-sm text-ink">{movementLabel}</dd>

        <dt className="text-sm font-medium text-ink-muted">Reference</dt>
        <dd className="font-mono text-sm text-ink">{watch.reference ?? "—"}</dd>

        {watch.notes ? (
          <>
            <dt className="text-sm font-medium text-ink-muted">Notes</dt>
            <dd className="whitespace-pre-wrap text-sm text-ink">{watch.notes}</dd>
          </>
        ) : null}

        <dt className="text-sm font-medium text-ink-muted">Added</dt>
        <dd className="text-sm text-ink">
          {new Date(watch.created_at).toLocaleString()}
        </dd>
      </dl>

      {readings.error ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink"
        >
          {readings.error}
        </p>
      ) : null}

      <WatchPhotoPanel
        watchId={watch.id}
        imageKey={watch.image_r2_key}
        onChanged={reloadWatch}
      />

      <SessionStatsPanel stats={readings.session_stats} />
      {readings.session_stats && readings.session_stats.reading_count > 0 ? (
        <div className="mb-6 rounded-card border border-line bg-canvas p-6 shadow-card md:p-7">
          <VerifiedProgressRing
            verifiedCount={Math.round(
              readings.session_stats.reading_count *
                readings.session_stats.verified_ratio,
            )}
            totalCount={readings.session_stats.reading_count}
            size={72}
          />
        </div>
      ) : null}
      <VerifiedReadingCapture watchId={watch.id} onSubmitted={reloadReadings} />
      <TapReadingForm watchId={watch.id} onLogged={reloadReadings} />
      <ReadingList
        readings={readings.readings}
        perInterval={readings.session_stats?.per_interval ?? []}
        onDeleted={reloadReadings}
      />

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <Link
          to={`/app/watches/${watch.id}/edit`}
          className="inline-flex min-h-[44px] items-center justify-center rounded-pill border border-line bg-canvas px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-accent hover:text-accent"
        >
          Edit
        </Link>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className="inline-flex min-h-[44px] items-center justify-center rounded-pill border border-accent/25 bg-accent/10 px-5 py-2.5 text-sm font-medium text-accent transition-colors hover:border-accent/40 hover:bg-accent/20 disabled:opacity-60"
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
        <Link
          to="/app/dashboard"
          className="ml-auto text-sm text-ink-muted hover:text-ink"
        >
          ← Back to dashboard
        </Link>
      </div>
    </section>
  );
}
