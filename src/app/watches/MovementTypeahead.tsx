// Movement typeahead. Used by the add/edit watch forms.
//
// UX contract:
//   * Debounced lookup (250 ms via useDebouncedValue) so each keystroke
//     doesn't hit the API.
//   * Up to 10 matches shown in a dropdown under the input.
//   * Clicking a match (or pressing Enter on the focused option) calls
//     `onSelect(movement)` and the parent decides what to do with the
//     selection — typically clear the dropdown and set hidden state.
//   * Pre-selected movement is rendered as a read-only confirmation
//     pill so the caller can use this component for "edit" flows too.
//   * Aborts the in-flight fetch when a new query supersedes it so the
//     dropdown never flashes stale rows after a fast keystroke burst.

import { useEffect, useMemo, useRef, useState } from "react";
import { searchMovements, type MovementOption } from "./api";
import { useDebouncedValue } from "./useDebouncedValue";
import {
  SubmitMovementSubForm,
  type SubmitMovementNotice,
} from "./SubmitMovementSubForm";

export interface MovementTypeaheadProps {
  /** Pre-selected movement, for edit flows. */
  initialSelection?: MovementOption | null;
  /** Called when the user picks a movement from the dropdown. */
  onSelect: (movement: MovementOption) => void;
  /** Called when the user clears the current selection. */
  onClear: () => void;
  /** Inline error from the server (e.g. "Please pick a valid movement"). */
  errorMessage?: string;
  /** Label override — defaults to "Movement". */
  label?: string;
}

export function MovementTypeahead({
  initialSelection = null,
  onSelect,
  onClear,
  errorMessage,
  label = "Movement",
}: MovementTypeaheadProps) {
  const [selection, setSelection] = useState<MovementOption | null>(initialSelection);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<MovementOption[]>([]);
  const [suggestions, setSuggestions] = useState<MovementOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  // Slice #10: inline sub-form to submit a new movement when the
  // current query has no match and the user clicks "Can't find it?".
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitNotice, setSubmitNotice] = useState<SubmitMovementNotice>(null);
  const inputId = useMemo(() => `movement-${Math.random().toString(36).slice(2, 8)}`, []);

  // Sync when a parent passes a new initial selection (e.g. after the
  // edit page finishes loading).
  useEffect(() => {
    setSelection(initialSelection);
  }, [initialSelection]);

  const debouncedQuery = useDebouncedValue(query, 250);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Don't search when the user hasn't typed anything yet, or when
    // a selection already exists and the input is untouched.
    if (selection) return;
    if (debouncedQuery.trim().length < 1) {
      setOptions([]);
      setSuggestions([]);
      setLoading(false);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    searchMovements(debouncedQuery.trim(), controller.signal).then(
      ({ approved, suggestions: suggested }) => {
        if (controller.signal.aborted) return;
        setOptions(approved);
        setSuggestions(suggested);
        setLoading(false);
        setOpen(true);
      },
    );
    return () => controller.abort();
  }, [debouncedQuery, selection]);

  function handleSelect(option: MovementOption) {
    setSelection(option);
    setQuery("");
    setOptions([]);
    setSuggestions([]);
    setOpen(false);
    onSelect(option);
  }

  function handleClear() {
    setSelection(null);
    setQuery("");
    setOptions([]);
    setSuggestions([]);
    setOpen(false);
    setSubmitOpen(false);
    setSubmitNotice(null);
    onClear();
  }

  function handleSubmitResolved(movement: MovementOption, notice: SubmitMovementNotice) {
    setSubmitOpen(false);
    setSubmitNotice(notice);
    // Auto-select the new (or collided) movement so the outer form can
    // submit the watch against it right away.
    handleSelect(movement);
  }

  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium tracking-wide text-ink-muted">
      <label htmlFor={inputId}>{label}</label>

      {selection ? (
        <div className="flex items-center gap-2 rounded-md border border-line bg-surface-inset px-3.5 py-2.5 shadow-inset-edge">
          <span className="flex-1 text-ink">
            {selection.canonical_name}
            {selection.status === "pending" ? (
              <span className="ml-2 inline-flex items-center gap-1 rounded-pill border border-accent/25 bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent">
                Pending approval
              </span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={handleClear}
            className="text-xs text-accent hover:underline"
          >
            Change
          </button>
        </div>
      ) : (
        <div className="relative">
          <input
            id={inputId}
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onBlur={() => {
              // Delay so a click on an option fires before the blur
              // closes the dropdown.
              setTimeout(() => setOpen(false), 150);
            }}
            onFocus={() => setOpen(options.length > 0 || suggestions.length > 0)}
            placeholder="Search calibers — e.g. ETA 2892-A2"
            aria-invalid={errorMessage ? true : undefined}
            aria-describedby={errorMessage ? `${inputId}-error` : undefined}
            className="w-full rounded-md border border-line bg-canvas px-3.5 py-2.5 font-sans text-base text-ink shadow-inset-edge outline-none transition-colors placeholder:text-ink-subtle focus:border-ink focus:outline-none focus:ring-2 focus:ring-black/10"
          />

          {open && query.trim().length > 0 ? (
            <ul
              role="listbox"
              className="absolute left-0 right-0 top-full z-10 mt-1 max-h-72 overflow-auto rounded-card border border-line bg-canvas shadow-card"
            >
              {loading ? (
                <li className="px-3 py-2 text-sm text-ink-muted">Searching…</li>
              ) : options.length === 0 && suggestions.length === 0 ? (
                <li className="px-3 py-2 text-sm text-ink-muted">
                  No calibers match “{query.trim()}”.{" "}
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      setSubmitOpen(true);
                      setOpen(false);
                    }}
                    className="text-accent hover:underline"
                  >
                    Can&rsquo;t find it? Submit new movement
                  </button>
                </li>
              ) : (
                <>
                  {options.map((option) => (
                    <li key={option.id}>
                      <button
                        type="button"
                        onMouseDown={(event) => {
                          // preventDefault stops the blur that would
                          // otherwise race the click and close the list
                          // before onClick fires.
                          event.preventDefault();
                          handleSelect(option);
                        }}
                        className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-surface"
                      >
                        <span className="font-sans text-base text-ink">
                          {option.canonical_name}
                        </span>
                        <span className="text-xs text-ink-muted">
                          {option.manufacturer} · {option.caliber} · {option.type}
                        </span>
                      </button>
                    </li>
                  ))}
                  {suggestions.length > 0 ? (
                    <li className="border-t border-line bg-surface px-3 py-1 text-xs font-medium uppercase tracking-wide text-ink-muted">
                      Your pending submissions
                    </li>
                  ) : null}
                  {suggestions.map((option) => (
                    <li key={`suggestion-${option.id}`}>
                      <button
                        type="button"
                        onMouseDown={(event) => {
                          event.preventDefault();
                          handleSelect(option);
                        }}
                        className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-surface"
                      >
                        <span className="font-sans text-base text-ink">
                          {option.canonical_name}
                          <span className="ml-2 rounded-full bg-accent/20 px-2 py-0.5 text-xs text-accent">
                            Pending
                          </span>
                        </span>
                        <span className="text-xs text-ink-muted">
                          {option.manufacturer} · {option.caliber} · {option.type}
                        </span>
                      </button>
                    </li>
                  ))}
                  <li className="border-t border-line px-3 py-2 text-sm">
                    <button
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        setSubmitOpen(true);
                        setOpen(false);
                      }}
                      className="text-accent hover:underline"
                    >
                      Can&rsquo;t find it? Submit new movement
                    </button>
                  </li>
                </>
              )}
            </ul>
          ) : null}
        </div>
      )}

      {submitOpen ? (
        <SubmitMovementSubForm
          initialCaliber={query.trim()}
          onCancel={() => setSubmitOpen(false)}
          onResolved={handleSubmitResolved}
        />
      ) : null}

      {submitNotice ? (
        <p
          role="status"
          className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink"
        >
          {submitNotice.kind === "created" ? (
            <>
              Submitted “{submitNotice.canonicalName}” for approval. Your watch can use it
              right away; it&rsquo;ll appear on leaderboards once an admin reviews it.
            </>
          ) : (
            <>
              We already have “{submitNotice.canonicalName}” in the catalog — your watch
              is now linked to the approved movement.
            </>
          )}
        </p>
      ) : null}

      {errorMessage ? (
        <span id={`${inputId}-error`} role="alert" className="text-sm text-accent">
          {errorMessage}
        </span>
      ) : (
        <span className="text-sm text-ink-muted">
          Movements power the accuracy leaderboards.
        </span>
      )}
    </div>
  );
}
