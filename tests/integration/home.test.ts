import { exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

// Public home page contract. These tests assert the design-system shape that
// slice 3 ships: warm palette tokens, zero client JS on /, hero tagline,
// and the cross-browser `theme-color` meta tag in both colour schemes.
//
// See issue #4.

describe("GET / — design system + home shell", () => {
  it("returns 200 HTML with Content-Type text/html", async () => {
    const response = await exports.default.fetch(
      new Request("https://ratedwatch.test/"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toMatch(/text\/html/);
  });

  it("includes theme-color meta tags for both light and dark schemes", async () => {
    const response = await exports.default.fetch(
      new Request("https://ratedwatch.test/"),
    );
    const body = await response.text();

    // Warm cream in light, near-black in dark — see CF Workers design doc.
    expect(body).toMatch(
      /<meta\s+name="theme-color"\s+content="#FFFBF5"\s+media="\(prefers-color-scheme:\s*light\)"\s*\/?>/,
    );
    expect(body).toMatch(
      /<meta\s+name="theme-color"\s+content="#121212"\s+media="\(prefers-color-scheme:\s*dark\)"\s*\/?>/,
    );
  });

  it("embeds the CF Workers design tokens as CSS custom properties", async () => {
    const response = await exports.default.fetch(
      new Request("https://ratedwatch.test/"),
    );
    const body = await response.text();

    // Accent, background, and text tokens must be present either inlined or
    // via a linked stylesheet. We assert the canonical hex values appear
    // somewhere in the served HTML so future refactors (inline vs linked
    // sheet) don't silently drop the palette.
    expect(body).toContain("#FF4801"); // primary accent
    expect(body).toContain("#FFFBF5"); // cream light bg
    expect(body).toContain("#121212"); // dark bg
  });

  it("renders the hero tagline", async () => {
    const response = await exports.default.fetch(
      new Request("https://ratedwatch.test/"),
    );
    const body = await response.text();

    // The tagline anchors the home page and the social share card. It must
    // appear in the SSR output so crawlers and no-JS clients see it.
    expect(body).toMatch(/Competitive accuracy tracking/i);
  });

  it("teases leaderboards as the next thing to ship", async () => {
    const response = await exports.default.fetch(
      new Request("https://ratedwatch.test/"),
    );
    const body = await response.text();
    expect(body).toMatch(/leaderboards/i);
  });

  it("emits zero client-side JavaScript — no <script> tags on /", async () => {
    const response = await exports.default.fetch(
      new Request("https://ratedwatch.test/"),
    );
    const body = await response.text();

    // Public pages must be pure SSR — any <script> tag (classic, module,
    // JSON-LD excluded intentionally here) is a regression against the
    // "no hydration on public pages" contract.
    expect(body).not.toMatch(/<script\b/i);
  });

  it("respects prefers-color-scheme via a CSS media query", async () => {
    const response = await exports.default.fetch(
      new Request("https://ratedwatch.test/"),
    );
    const body = await response.text();
    expect(body).toMatch(/prefers-color-scheme\s*:\s*dark/i);
  });
});
