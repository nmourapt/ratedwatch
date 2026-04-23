// Chrono24 link builder — the single place that constructs a URL
// pointing at Chrono24. Every caller (public movement page, future
// SPA CTA, future emails) MUST go through this function so the
// affiliate-ID wrapping planned for a later slice is a one-line
// change here rather than a grep-and-replace across the repo.
//
// Phase 1 behaviour: return a plain search URL — no affiliate wrapper
// yet. The function accepts the movement's full shape (canonical_name
// + manufacturer + caliber) even though phase 1 only consumes
// `canonical_name`, so the signature is stable when the affiliate
// rewrite starts keying off the other fields.

export interface Chrono24LinkInput {
  canonical_name: string;
  manufacturer: string;
  caliber: string;
}

/**
 * Build a URL pointing at a Chrono24 search for the given movement.
 *
 * The returned `URL` uses the canonical name as the `query` search
 * parameter. `URL.searchParams.set` handles all percent-encoding so
 * callers never need to worry about special characters.
 */
export function buildChrono24Url(movement: Chrono24LinkInput): URL {
  const url = new URL("https://www.chrono24.com/search/index.htm");
  url.searchParams.set("query", movement.canonical_name.trim());
  return url;
}
