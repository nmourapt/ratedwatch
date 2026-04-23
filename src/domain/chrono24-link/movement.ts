// Movement-focused Chrono24 URL builder — used by /m/:id to link out
// to Chrono24's listing for watches using the given caliber.
//
// Signature accepts the movement's full shape even though phase 1
// only consumes `canonical_name`, so the signature stays stable when
// the future affiliate rewrite starts keying off the other fields.

export interface MovementLinkInput {
  canonical_name: string;
  manufacturer: string;
  caliber: string;
}

export function buildChrono24UrlForMovement(movement: MovementLinkInput): URL {
  const url = new URL("https://www.chrono24.com/search/index.htm");
  url.searchParams.set("query", movement.canonical_name.trim());
  return url;
}
