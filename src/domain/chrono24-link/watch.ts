// Watch-focused Chrono24 URL builder — used by /w/:id to link out
// to Chrono24's listing for similar watches based on the owner's
// brand + model (falling back to the watch name).
//
// Pure function. No IO, no Workers bindings. Unit-tested.

export interface WatchLinkInput {
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
 * Build a Chrono24 URL for a "buy one like this" CTA on a watch page.
 *
 * Precedence for the search term:
 *   1. `brand model` when at least one of them is non-empty.
 *   2. `name` as a last resort.
 *   3. No search term → storefront URL (no `?query=…`).
 */
export function buildChrono24UrlForWatch(q: WatchLinkInput): string {
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
