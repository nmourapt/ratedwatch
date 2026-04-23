// Unit tests for the Chrono24 search URL builder.
//
// Phase 1 thesis: revenue comes from Chrono24 affiliate links on the
// public surfaces (movement page, per-watch page). The actual affiliate
// param is stubbed — for now we just craft a plain search URL. This
// module stays pure so both the SSR pages and any future JSON surface
// can compose it without spinning up a Worker.

import { describe, expect, it } from "vitest";
import { buildChrono24UrlForWatch } from "./watch";

describe("buildChrono24UrlForWatch()", () => {
  it("returns the storefront URL when no search terms are provided", () => {
    expect(buildChrono24UrlForWatch({})).toBe("https://www.chrono24.com/");
    expect(buildChrono24UrlForWatch({ brand: null, model: null })).toBe(
      "https://www.chrono24.com/",
    );
  });

  it("builds a search URL from brand + model", () => {
    const url = buildChrono24UrlForWatch({ brand: "Rolex", model: "Submariner" });
    expect(url).toMatch(/^https:\/\/www\.chrono24\.com\/search\/index\.htm\?/);
    expect(url).toContain("query=Rolex+Submariner");
  });

  it("falls back to the watch name when brand + model are missing", () => {
    const url = buildChrono24UrlForWatch({ name: "Gold Submariner" });
    expect(url).toContain("query=Gold+Submariner");
  });

  it("URL-encodes special characters in the query", () => {
    const url = buildChrono24UrlForWatch({ brand: "A. Lange & Söhne", model: "Zeitwerk" });
    // The "&" must be encoded so it doesn't break the querystring.
    expect(url).toContain("query=A.+Lange+%26+S%C3%B6hne+Zeitwerk");
  });

  it("trims and collapses internal whitespace", () => {
    const url = buildChrono24UrlForWatch({ brand: "  Seiko  ", model: "  SRP777 " });
    expect(url).toContain("query=Seiko+SRP777");
  });
});
