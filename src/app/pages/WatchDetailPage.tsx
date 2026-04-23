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
import { LogReadingForm } from "../watches/LogReadingForm";
import { ReadingList } from "../watches/ReadingList";
import { SessionStatsPanel } from "../watches/SessionStatsPanel";
import { WatchPhotoPanel } from "../watches/WatchPhotoPanel";
import { deleteWatch, getWatch, type Watch } from "../watches/api";
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

  if (state.kind === "loading") {
    return (
      <section className="mx-auto max-w-2xl">
        <p className="font-mono text-sm text-cf-text-subtle">Loading watch…</p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section className="mx-auto max-w-2xl">
        <p
          role="alert"
          className="rounded-md border border-cf-orange/40 bg-cf-orange/10 px-3 py-2 text-sm text-cf-text"
        >
          {state.message}
        </p>
        <Link
          to="/app/dashboard"
          className="mt-4 inline-block text-sm text-cf-orange hover:underline"
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
          <h1 className="mb-1 text-4xl font-medium tracking-tight text-cf-text">
            {watch.name}
          </h1>
          <p className="text-cf-text-muted">
            {watch.brand || watch.model
              ? [watch.brand, watch.model].filter(Boolean).join(" ")
              : "No brand/model set"}
          </p>
        </div>
        <span
          className={
            watch.is_public
              ? "rounded-full border border-cf-border bg-cf-bg-200 px-3 py-1 text-xs font-medium text-cf-text-muted"
              : "rounded-full border border-cf-orange/40 bg-cf-orange/10 px-3 py-1 text-xs font-medium text-cf-orange"
          }
        >
          {watch.is_public ? "Public" : "Private"}
        </span>
      </div>

      <dl className="mb-8 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[140px_1fr]">
        <dt className="text-sm font-medium text-cf-text-muted">Movement</dt>
        <dd className="text-sm text-cf-text">{movementLabel}</dd>

        {watch.notes ? (
          <>
            <dt className="text-sm font-medium text-cf-text-muted">Notes</dt>
            <dd className="whitespace-pre-wrap text-sm text-cf-text">{watch.notes}</dd>
          </>
        ) : null}

        <dt className="text-sm font-medium text-cf-text-muted">Added</dt>
        <dd className="text-sm text-cf-text">
          {new Date(watch.created_at).toLocaleString()}
        </dd>
      </dl>

      {readings.error ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-cf-orange/40 bg-cf-orange/10 px-3 py-2 text-sm text-cf-text"
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
      <LogReadingForm watchId={watch.id} onLogged={reloadReadings} />
      <ReadingList
        readings={readings.readings}
        perInterval={readings.session_stats?.per_interval ?? []}
        onDeleted={reloadReadings}
      />

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <Link
          to={`/app/watches/${watch.id}/edit`}
          className="inline-flex items-center justify-center rounded-full border border-cf-border bg-transparent px-5 py-2.5 text-sm font-medium text-cf-text transition-colors hover:border-cf-orange hover:text-cf-orange"
        >
          Edit
        </Link>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className="inline-flex items-center justify-center rounded-full border border-cf-orange/40 bg-cf-orange/10 px-5 py-2.5 text-sm font-medium text-cf-orange transition-colors hover:border-cf-orange hover:bg-cf-orange/20 disabled:opacity-60"
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
        <Link
          to="/app/dashboard"
          className="ml-auto text-sm text-cf-text-muted hover:text-cf-text"
        >
          ← Back to dashboard
        </Link>
      </div>
    </section>
  );
}
