// Unit tests for the chrono24-link domain module.
//
// The module is the single place where Chrono24 URLs are constructed.
// Phase 1 returns a plain search URL; a later slice will wrap it with
// an affiliate ID. Callers MUST go through this function so the
// affiliate migration is a one-line change.

import { describe, it, expect } from "vitest";
import { buildChrono24Url } from "./index";

describe("buildChrono24Url", () => {
  it("returns a URL pointing at chrono24.com search", () => {
    const url = buildChrono24Url({
      canonical_name: "ETA 2892-A2",
      manufacturer: "ETA",
      caliber: "2892-A2",
    });
    expect(url).toBeInstanceOf(URL);
    expect(url.origin).toBe("https://www.chrono24.com");
    expect(url.pathname).toBe("/search/index.htm");
  });

  it("encodes the canonical name as the `query` search parameter", () => {
    const url = buildChrono24Url({
      canonical_name: "ETA 2892-A2",
      manufacturer: "ETA",
      caliber: "2892-A2",
    });
    expect(url.searchParams.get("query")).toBe("ETA 2892-A2");
    // URL serialization turns the space into a + (form encoding).
    expect(url.toString()).toBe(
      "https://www.chrono24.com/search/index.htm?query=ETA+2892-A2",
    );
  });

  it("url-encodes reserved characters (ampersand, slash, spaces)", () => {
    const url = buildChrono24Url({
      canonical_name: "Brand & Co / Caliber 42",
      manufacturer: "Brand & Co",
      caliber: "42",
    });
    // The raw query param should still read back as the original string.
    expect(url.searchParams.get("query")).toBe("Brand & Co / Caliber 42");
    // And the serialized URL must have encoded the ampersand so it
    // doesn't introduce a new query parameter.
    const serialized = url.toString();
    expect(serialized).not.toMatch(/[?&]query=Brand &/);
    expect(serialized).toMatch(/%26/); // encoded ampersand
    expect(serialized).toMatch(/%2F/); // encoded forward slash
  });

  it("handles unicode in the canonical name", () => {
    const url = buildChrono24Url({
      canonical_name: "Omega Cøaxial 8800 — ∞",
      manufacturer: "Omega",
      caliber: "8800",
    });
    expect(url.searchParams.get("query")).toBe("Omega Cøaxial 8800 — ∞");
    // Non-ASCII must be percent-encoded in the serialized form.
    expect(url.toString()).toMatch(/%C3%B8/i); // ø encoded as UTF-8
  });

  it("still builds a URL when manufacturer and caliber are empty strings", () => {
    // A pending movement could have sparse fields — the function must
    // never throw. It uses canonical_name only in phase 1 so empty
    // ancillary fields have no effect on the output.
    const url = buildChrono24Url({
      canonical_name: "Unknown Movement",
      manufacturer: "",
      caliber: "",
    });
    expect(url.searchParams.get("query")).toBe("Unknown Movement");
  });

  it("trims whitespace from the canonical name before encoding", () => {
    const url = buildChrono24Url({
      canonical_name: "  Seiko 6R35  ",
      manufacturer: "Seiko",
      caliber: "6R35",
    });
    expect(url.searchParams.get("query")).toBe("Seiko 6R35");
  });
});
