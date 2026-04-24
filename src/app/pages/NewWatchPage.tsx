// Add-watch screen. Thin wrapper around <WatchForm>; on success it
// redirects to the detail page for the newly created watch so the
// user can immediately see the record and start wiring readings in
// later slices.

import { useNavigate, Link } from "react-router";
import { createWatch } from "../watches/api";
import { EMPTY_WATCH_FORM, WatchForm, type WatchFormValues } from "../watches/WatchForm";

export function NewWatchPage() {
  const navigate = useNavigate();

  async function handleSubmit(values: WatchFormValues) {
    // The typeahead guarantees `movement` is non-null when submit fires.
    if (!values.movement) {
      return {
        ok: false as const,
        error: {
          code: "invalid_movement" as const,
          message: "Please pick a movement from the list",
        },
      };
    }
    const body = {
      name: values.name.trim(),
      brand: values.brand.trim() || undefined,
      model: values.model.trim() || undefined,
      reference: values.reference.trim() || undefined,
      movement_id: values.movement.id,
      notes: values.notes.trim() || undefined,
      is_public: values.is_public,
    };
    const result = await createWatch(body);
    if (!result.ok) return result;
    navigate(`/app/watches/${result.watch.id}`, { replace: true });
    return { ok: true as const };
  }

  return (
    <section className="mx-auto max-w-2xl">
      <h1 className="mb-2 font-display text-4xl font-light tracking-tight text-ink">
        Add a watch
      </h1>
      <p className="mb-6 text-ink-muted">
        Add one of your watches to start tracking accuracy. You can always rename or
        toggle visibility later.
      </p>
      <WatchForm
        initialValues={EMPTY_WATCH_FORM}
        submitLabel="Add watch"
        submittingLabel="Adding…"
        onSubmit={handleSubmit}
        secondaryAction={
          <Link to="/app/dashboard" className="text-sm text-ink-muted hover:text-ink">
            Cancel
          </Link>
        }
      />
    </section>
  );
}
