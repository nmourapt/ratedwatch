// Shared form for the add + edit watch flows. The parent supplies the
// initial values, a submit handler, and a label for the primary
// button; the form tracks field values, per-field errors (mirroring
// the server's `fieldErrors` map), and the submitting flag.
//
// Input styling matches src/app/pages/SettingsPage.tsx and the login /
// register forms so the authed surface feels consistent.

import { type FormEvent, useState } from "react";
import { MovementTypeahead } from "./MovementTypeahead";
import type { MovementOption } from "./api";
import type { WatchError } from "./api";

export interface WatchFormValues {
  name: string;
  brand: string;
  model: string;
  /** Slice (issue #57): manufacturer reference, e.g. "3570.50". */
  reference: string;
  notes: string;
  is_public: boolean;
  movement: MovementOption | null;
}

export const EMPTY_WATCH_FORM: WatchFormValues = {
  name: "",
  brand: "",
  model: "",
  reference: "",
  notes: "",
  is_public: true,
  movement: null,
};

export interface WatchFormProps {
  initialValues: WatchFormValues;
  submitLabel: string;
  submittingLabel: string;
  /** Return `{ ok: true }` to signal a happy submit — the form clears
   *  its error state. Anything else surfaces the given error. */
  onSubmit: (
    values: WatchFormValues,
  ) => Promise<{ ok: true } | { ok: false; error: WatchError }>;
  /** Optional link / button rendered after the primary action (e.g.
   *  "Cancel" on the edit screen). */
  secondaryAction?: React.ReactNode;
}

export function WatchForm({
  initialValues,
  submitLabel,
  submittingLabel,
  onSubmit,
  secondaryAction,
}: WatchFormProps) {
  const [values, setValues] = useState<WatchFormValues>(initialValues);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFieldErrors({});
    setFormError(null);

    if (!values.movement) {
      setFieldErrors({ movement_id: "Please pick a movement from the list" });
      return;
    }

    setSubmitting(true);
    const result = await onSubmit(values);
    setSubmitting(false);
    if (result.ok) return;

    if (result.error.code === "invalid_input" && result.error.fieldErrors) {
      setFieldErrors(result.error.fieldErrors);
      return;
    }
    if (result.error.code === "invalid_movement") {
      setFieldErrors({ movement_id: result.error.message });
      return;
    }
    setFormError(result.error.message);
  }

  function update<K extends keyof WatchFormValues>(key: K, value: WatchFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    if (fieldErrors[key as string]) {
      setFieldErrors(({ [key as string]: _ignored, ...rest }) => rest);
    }
  }

  // Shared class fragments so the 4 text inputs + textarea stay in
  // lockstep. Focus ring is soft black (10 % opacity) per DESIGN.md
  // section 6; errored state uses a subtle red hue without a loud box.
  const fieldBase =
    "rounded-md bg-canvas px-3.5 py-2.5 font-sans text-base text-ink shadow-inset-edge outline-none transition-colors focus:outline-none placeholder:text-ink-subtle";
  const fieldIdleCx =
    "border border-line focus:border-ink focus:ring-2 focus:ring-black/10";
  const fieldErrorCx =
    "border border-accent/60 focus:border-accent focus:ring-2 focus:ring-red-500/20";
  const labelCx =
    "flex flex-col gap-1.5 text-sm font-medium tracking-wide text-ink-muted";

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
      <label className={labelCx}>
        Name
        <input
          type="text"
          required
          maxLength={100}
          value={values.name}
          onChange={(event) => update("name", event.target.value)}
          aria-invalid={fieldErrors.name ? true : undefined}
          className={`${fieldBase} ${fieldErrors.name ? fieldErrorCx : fieldIdleCx}`}
        />
        {fieldErrors.name ? (
          <span role="alert" className="text-sm text-accent">
            {fieldErrors.name}
          </span>
        ) : null}
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className={labelCx}>
          Brand
          <input
            type="text"
            maxLength={100}
            value={values.brand}
            onChange={(event) => update("brand", event.target.value)}
            aria-invalid={fieldErrors.brand ? true : undefined}
            className={`${fieldBase} ${fieldErrors.brand ? fieldErrorCx : fieldIdleCx}`}
          />
          {fieldErrors.brand ? (
            <span role="alert" className="text-sm text-accent">
              {fieldErrors.brand}
            </span>
          ) : null}
        </label>

        <label className={labelCx}>
          Model
          <input
            type="text"
            maxLength={100}
            value={values.model}
            onChange={(event) => update("model", event.target.value)}
            aria-invalid={fieldErrors.model ? true : undefined}
            className={`${fieldBase} ${fieldErrors.model ? fieldErrorCx : fieldIdleCx}`}
          />
          {fieldErrors.model ? (
            <span role="alert" className="text-sm text-accent">
              {fieldErrors.model}
            </span>
          ) : null}
        </label>
      </div>

      <label className={labelCx}>
        Reference (optional)
        <input
          type="text"
          maxLength={50}
          placeholder="e.g. 3570.50"
          value={values.reference}
          onChange={(event) => update("reference", event.target.value)}
          aria-invalid={fieldErrors.reference ? true : undefined}
          className={`${fieldBase} ${fieldErrors.reference ? fieldErrorCx : fieldIdleCx}`}
        />
        {fieldErrors.reference ? (
          <span role="alert" className="text-sm text-accent">
            {fieldErrors.reference}
          </span>
        ) : null}
      </label>

      <MovementTypeahead
        initialSelection={values.movement}
        onSelect={(m) => update("movement", m)}
        onClear={() => update("movement", null)}
        errorMessage={fieldErrors.movement_id}
      />

      <label className={labelCx}>
        Notes
        <textarea
          rows={3}
          maxLength={1000}
          value={values.notes}
          onChange={(event) => update("notes", event.target.value)}
          aria-invalid={fieldErrors.notes ? true : undefined}
          className={`${fieldBase} ${fieldErrors.notes ? fieldErrorCx : fieldIdleCx}`}
        />
        {fieldErrors.notes ? (
          <span role="alert" className="text-sm text-accent">
            {fieldErrors.notes}
          </span>
        ) : null}
      </label>

      <label className="flex items-center gap-2 text-sm font-medium text-ink">
        <input
          type="checkbox"
          checked={values.is_public}
          onChange={(event) => update("is_public", event.target.checked)}
          className="h-4 w-4 rounded border-line accent-accent"
        />
        Public — visible on leaderboards and your public profile
      </label>

      {formError ? (
        <p
          role="alert"
          className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink"
        >
          {formError}
        </p>
      ) : null}

      <div className="mt-2 flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex min-h-[44px] items-center justify-center rounded-pill bg-accent px-6 py-3 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {submitting ? submittingLabel : submitLabel}
        </button>
        {secondaryAction}
      </div>
    </form>
  );
}
