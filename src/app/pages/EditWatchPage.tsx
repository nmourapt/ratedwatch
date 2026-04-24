// Edit-watch screen. Loads the current watch, pre-fills the shared
// <WatchForm>, then PATCHes on submit. On success it redirects back
// to the detail page so the reader sees the fresh state.

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  getWatch,
  updateWatch,
  searchMovements,
  type MovementOption,
  type Watch,
} from "../watches/api";
import { WatchForm, type WatchFormValues, EMPTY_WATCH_FORM } from "../watches/WatchForm";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; watch: Watch; initialValues: WatchFormValues }
  | { kind: "error"; message: string };

/**
 * Turn an API `Watch` into form values. The typeahead needs a full
 * `MovementOption` rather than just an id, so when the watch has a
 * movement we re-hydrate it by searching the canonical name and
 * taking the matching row. This is cheap (the taxonomy is ~100 rows)
 * and avoids a dedicated GET /movements/:id endpoint just for this
 * flow.
 */
async function hydrateInitialValues(watch: Watch): Promise<WatchFormValues> {
  let movement: MovementOption | null = null;
  if (watch.movement_id && watch.movement_canonical_name) {
    const { approved } = await searchMovements(watch.movement_canonical_name);
    movement = approved.find((m) => m.id === watch.movement_id) ?? null;
    // If search didn't return the row (e.g. pending, or the canonical
    // name changed), fall back to a minimal synthetic option so the
    // typeahead still shows a "currently selected" pill.
    if (!movement) {
      movement = {
        id: watch.movement_id,
        canonical_name: watch.movement_canonical_name,
        manufacturer: "",
        caliber: "",
        type: "",
        status: "approved",
      };
    }
  }
  return {
    ...EMPTY_WATCH_FORM,
    name: watch.name,
    brand: watch.brand ?? "",
    model: watch.model ?? "",
    reference: watch.reference ?? "",
    notes: watch.notes ?? "",
    is_public: watch.is_public,
    movement,
  };
}

export function EditWatchPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const result = await getWatch(id);
      if (cancelled) return;
      if (!result.ok) {
        setState({ kind: "error", message: result.error.message });
        return;
      }
      const initialValues = await hydrateInitialValues(result.watch);
      if (cancelled) return;
      setState({ kind: "loaded", watch: result.watch, initialValues });
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function handleSubmit(values: WatchFormValues) {
    if (!id) {
      return {
        ok: false as const,
        error: {
          code: "unknown" as const,
          message: "Missing watch id",
        },
      };
    }
    if (!values.movement) {
      return {
        ok: false as const,
        error: {
          code: "invalid_movement" as const,
          message: "Please pick a movement from the list",
        },
      };
    }
    // Trim every free-text field; for `reference` we send the trimmed
    // value directly (even empty string) so the PATCH handler can map
    // "" → NULL and clear a previously-set reference.
    const body = {
      name: values.name.trim(),
      brand: values.brand.trim() || undefined,
      model: values.model.trim() || undefined,
      reference: values.reference.trim(),
      movement_id: values.movement.id,
      notes: values.notes.trim() || undefined,
      is_public: values.is_public,
    };
    const result = await updateWatch(id, body);
    if (!result.ok) return result;
    navigate(`/app/watches/${id}`, { replace: true });
    return { ok: true as const };
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

  return (
    <section className="mx-auto max-w-2xl">
      <h1 className="mb-2 text-4xl font-medium tracking-tight text-ink">
        Edit watch
      </h1>
      <p className="mb-6 text-ink-muted">
        Update details, movement, or visibility. Readings are not affected.
      </p>
      <WatchForm
        initialValues={state.initialValues}
        submitLabel="Save changes"
        submittingLabel="Saving…"
        onSubmit={handleSubmit}
        secondaryAction={
          <Link
            to={`/app/watches/${state.watch.id}`}
            className="text-sm text-ink-muted hover:text-ink"
          >
            Cancel
          </Link>
        }
      />
    </section>
  );
}
