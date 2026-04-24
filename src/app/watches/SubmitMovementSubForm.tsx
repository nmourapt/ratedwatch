// Inline "submit a new movement" sub-form (slice #10).
//
// Rendered below <MovementTypeahead> when the user has no match for
// their current query and clicks the "Can't find it?" affordance. On
// successful submit the parent wires the returned movement into the
// typeahead selection so the user can immediately add the watch
// against the newly-created pending row. On an approved-slug collision
// the backend returns the existing approved row and we do the same
// auto-select (with a different notice).

import { type FormEvent, useState } from "react";
import { submitMovement, type MovementOption, type SubmitMovementBody } from "./api";

export type SubmitMovementNotice =
  | null
  | { kind: "created"; canonicalName: string }
  | { kind: "already_approved"; canonicalName: string };

export interface SubmitMovementSubFormProps {
  /** Pre-fills the caliber input so the user doesn't retype it. */
  initialCaliber?: string;
  /** Called when the user cancels without submitting. */
  onCancel: () => void;
  /**
   * Called with the movement row to use for the parent watch form.
   * The hosting component auto-selects it in the typeahead and
   * collapses this sub-form. `notice` is an optional user-facing hint
   * the parent renders (e.g. "Submitted for approval").
   */
  onResolved: (movement: MovementOption, notice: SubmitMovementNotice) => void;
}

type MovementType = SubmitMovementBody["type"];

const TYPE_OPTIONS: { value: MovementType; label: string }[] = [
  { value: "automatic", label: "Automatic" },
  { value: "manual", label: "Manual wind" },
  { value: "quartz", label: "Quartz" },
  { value: "spring-drive", label: "Spring Drive" },
  { value: "other", label: "Other" },
];

export function SubmitMovementSubForm({
  initialCaliber = "",
  onCancel,
  onResolved,
}: SubmitMovementSubFormProps) {
  const [canonicalName, setCanonicalName] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [caliber, setCaliber] = useState(initialCaliber);
  const [type, setType] = useState<MovementType>("automatic");
  const [notes, setNotes] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFieldErrors({});
    setFormError(null);
    setSubmitting(true);
    const result = await submitMovement({
      canonical_name: canonicalName.trim(),
      manufacturer: manufacturer.trim(),
      caliber: caliber.trim(),
      type,
      notes: notes.trim() || undefined,
    });
    setSubmitting(false);

    switch (result.status) {
      case "created":
      case "exists_pending_own":
        onResolved(result.movement, {
          kind: "created",
          canonicalName: result.movement.canonical_name,
        });
        return;
      case "exists_approved":
      case "exists_pending_other":
        // The slug already exists — hand the existing movement to the
        // parent so the watch can still be created, but flag it so the
        // UI renders a "we already have this" notice instead of the
        // "submitted for approval" one.
        onResolved(result.movement, {
          kind: "already_approved",
          canonicalName: result.movement.canonical_name,
        });
        return;
      case "invalid_input":
        setFieldErrors(result.fieldErrors);
        return;
      case "unauthorized":
        setFormError("Your session has expired. Please sign in again.");
        return;
      case "unknown":
        setFormError(result.message);
        return;
    }
  }

  return (
    <form
      className="mt-2 flex flex-col gap-3 rounded-md border border-line bg-surface p-4 text-sm"
      onSubmit={handleSubmit}
      noValidate
    >
      <p className="text-ink-muted">
        Tell us about the caliber. An admin will review and approve it — you can still add
        your watch right now.
      </p>

      <label className="flex flex-col gap-1 font-medium text-ink">
        Display name
        <input
          type="text"
          required
          maxLength={100}
          value={canonicalName}
          onChange={(event) => setCanonicalName(event.target.value)}
          placeholder="e.g. Seiko NH36A"
          aria-invalid={fieldErrors.canonical_name ? true : undefined}
          className="rounded-md border border-line bg-canvas px-3 py-2 font-sans text-base text-ink outline-none focus:border-accent"
        />
        {fieldErrors.canonical_name ? (
          <span role="alert" className="text-sm text-accent">
            {fieldErrors.canonical_name}
          </span>
        ) : null}
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 font-medium text-ink">
          Manufacturer
          <input
            type="text"
            required
            maxLength={50}
            value={manufacturer}
            onChange={(event) => setManufacturer(event.target.value)}
            placeholder="e.g. Seiko"
            aria-invalid={fieldErrors.manufacturer ? true : undefined}
            className="rounded-md border border-line bg-canvas px-3 py-2 font-sans text-base text-ink outline-none focus:border-accent"
          />
          {fieldErrors.manufacturer ? (
            <span role="alert" className="text-sm text-accent">
              {fieldErrors.manufacturer}
            </span>
          ) : null}
        </label>
        <label className="flex flex-col gap-1 font-medium text-ink">
          Caliber
          <input
            type="text"
            required
            maxLength={50}
            value={caliber}
            onChange={(event) => setCaliber(event.target.value)}
            placeholder="e.g. NH36A"
            aria-invalid={fieldErrors.caliber ? true : undefined}
            className="rounded-md border border-line bg-canvas px-3 py-2 font-sans text-base text-ink outline-none focus:border-accent"
          />
          {fieldErrors.caliber ? (
            <span role="alert" className="text-sm text-accent">
              {fieldErrors.caliber}
            </span>
          ) : null}
        </label>
      </div>

      <label className="flex flex-col gap-1 font-medium text-ink">
        Type
        <select
          value={type}
          onChange={(event) => setType(event.target.value as MovementType)}
          aria-invalid={fieldErrors.type ? true : undefined}
          className="rounded-md border border-line bg-canvas px-3 py-2 font-sans text-base text-ink outline-none focus:border-accent"
        >
          {TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {fieldErrors.type ? (
          <span role="alert" className="text-sm text-accent">
            {fieldErrors.type}
          </span>
        ) : null}
      </label>

      <label className="flex flex-col gap-1 font-medium text-ink">
        Notes (optional)
        <textarea
          rows={2}
          maxLength={500}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Where did you learn about this caliber? Any references?"
          aria-invalid={fieldErrors.notes ? true : undefined}
          className="rounded-md border border-line bg-canvas px-3 py-2 font-sans text-base text-ink outline-none focus:border-accent"
        />
        {fieldErrors.notes ? (
          <span role="alert" className="text-sm text-accent">
            {fieldErrors.notes}
          </span>
        ) : null}
      </label>

      {formError ? (
        <p
          role="alert"
          className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-ink"
        >
          {formError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center justify-center rounded-full bg-accent px-5 py-2 text-sm font-medium text-[#fffbf5] transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {submitting ? "Submitting…" : "Submit movement"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-ink-muted hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
