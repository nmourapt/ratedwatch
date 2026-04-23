// Chrono24 search URL builder.
//
// Phase 1 thesis (see PRD issue #1): revenue from Chrono24 affiliate
// links on movement + watch pages. The affiliate programme isn't wired
// up yet — this module emits a plain public search URL that the CTA
// button on /m/:id (slice 14) and /w/:id (slice 15) both link to. When
// the affiliate tag lands, swap the query string here and every caller
// picks it up for free.
//
// Pure function. No IO, no Workers bindings. Unit-tested.

export interface Chrono24Query {
  /** Watch brand, e.g. "Rolex". */
  brand?: string | null;
  /** Watch model, e.g. "Submariner". */
  model?: string | null;
  /** User-chosen name, used only when brand + model are both blank. */
  name?: string | null;
}

const STOREFRONT = "https://www.chrono24.com/";
const SEARCH_BASE = "https://www.chrono24.com/search/index.htm";

/**
 * Build a Chrono24 URL for a "buy one like this" CTA.
 *
 * Precedence for the search term:
 *   1. `brand model` when at least one of them is non-empty.
 *   2. `name` as a last resort.
 *   3. No search term → storefront URL (no `?query=…`).
 */
export function buildChrono24Url(q: Chrono24Query): string {
  const parts: string[] = [];
  const brand = (q.brand ?? "").trim();
  const model = (q.model ?? "").trim();
  if (brand) parts.push(brand);
  if (model) parts.push(model);

  if (parts.length === 0) {
    const name = (q.name ?? "").trim();
    if (name) parts.push(name);
  }

  if (parts.length === 0) return STOREFRONT;

  // Collapse any internal runs of whitespace so " a   b " becomes "a b"
  // before URL-encoding.
  const query = parts.join(" ").replace(/\s+/g, " ").trim();
  const encoded = new URLSearchParams({ query }).toString();
  return `${SEARCH_BASE}?${encoded}`;
}
