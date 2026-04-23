// Read-only view of a single watch with Edit + Delete affordances.
// Readings / drift charts land in a later slice; the layout here
// leaves room for that section beneath the metadata.

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { deleteWatch, getWatch, type Watch } from "../watches/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; watch: Watch }
  | { kind: "error"; message: string };

export function WatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [deleting, setDeleting] = useState(false);

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
    <section className="mx-auto max-w-2xl">
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

      <div className="mb-10 rounded-md border border-cf-border bg-cf-bg-200 px-4 py-3 text-sm text-cf-text-muted">
        Readings, drift charts, and session stats ship in a later slice.
      </div>

      <div className="flex flex-wrap items-center gap-3">
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
