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
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
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
      setLoading(false);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    searchMovements(debouncedQuery.trim(), controller.signal).then(({ approved }) => {
      if (controller.signal.aborted) return;
      setOptions(approved);
      setLoading(false);
      setOpen(true);
    });
    return () => controller.abort();
  }, [debouncedQuery, selection]);

  function handleSelect(option: MovementOption) {
    setSelection(option);
    setQuery("");
    setOptions([]);
    setOpen(false);
    onSelect(option);
  }

  function handleClear() {
    setSelection(null);
    setQuery("");
    setOptions([]);
    setOpen(false);
    onClear();
  }

  return (
    <div className="flex flex-col gap-1 text-sm font-medium text-cf-text">
      <label htmlFor={inputId}>{label}</label>

      {selection ? (
        <div className="flex items-center gap-2 rounded-md border border-cf-border bg-cf-bg-200 px-3 py-2">
          <span className="flex-1 text-cf-text">{selection.canonical_name}</span>
          <button
            type="button"
            onClick={handleClear}
            className="text-xs text-cf-orange hover:underline"
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
            onFocus={() => setOpen(options.length > 0)}
            placeholder="Search calibers — e.g. ETA 2892-A2"
            aria-invalid={errorMessage ? true : undefined}
            aria-describedby={errorMessage ? `${inputId}-error` : undefined}
            className="w-full rounded-md border border-cf-border bg-cf-bg-100 px-3 py-2 font-sans text-base text-cf-text outline-none focus:border-cf-orange"
          />

          {open && query.trim().length > 0 ? (
            <ul
              role="listbox"
              className="absolute left-0 right-0 top-full z-10 mt-1 max-h-72 overflow-auto rounded-md border border-cf-border bg-cf-bg-100 shadow-lg"
            >
              {loading ? (
                <li className="px-3 py-2 text-sm text-cf-text-muted">Searching…</li>
              ) : options.length === 0 ? (
                <li className="px-3 py-2 text-sm text-cf-text-muted">
                  No calibers match “{query.trim()}”.
                </li>
              ) : (
                options.map((option) => (
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
                      className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-cf-bg-200"
                    >
                      <span className="font-sans text-base text-cf-text">
                        {option.canonical_name}
                      </span>
                      <span className="text-xs text-cf-text-muted">
                        {option.manufacturer} · {option.caliber} · {option.type}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </div>
      )}

      {errorMessage ? (
        <span id={`${inputId}-error`} role="alert" className="text-sm text-cf-orange">
          {errorMessage}
        </span>
      ) : (
        <span className="text-sm text-cf-text-muted">
          Movements power the accuracy leaderboards.
        </span>
      )}
    </div>
  );
}
