// Tiny lodash-free debounce hook. Returns the input value only after
// it has been stable for `delayMs` milliseconds — used by the add-watch
// typeahead to avoid a request per keystroke (PRD slice 8 requires
// debounce ≥ 250 ms).
//
// Kept local to the app surface because the single current consumer
// doesn't justify a shared util module.

import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}
