import { exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

// Public home page contract. These tests assert the design-system shape that
// slice 3 ships: warm palette tokens, zero client JS on /, hero tagline,
// and the cross-browser `theme-color` meta tag in both colour schemes.
//
// See issue #4.

describe("GET / — design system + home shell", () => {
  it("returns 200 HTML with Content-Type text/html", async () => {
    const response = await exports.default.fetch(new Request("https://ratedwatch.test/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toMatch(/text\/html/);
  });

  it("includes theme-color meta tags for both light and dark schemes", async () => {
    const response = await exports.default.fetch(new Request("https://ratedwatch.test/"));
    const body = await response.text();

    // Palette v3 (cool-neutral zinc): near-white page in light, full
    // Palette v4 (ElevenLabs-inspired warm-white). Pure white canvas
    // in light, near-black canvas in dark. See DESIGN.md for the full
    // rationale and the historical zinc → warm-white transition.
    expect(body).toMatch(
      /<meta\s+name="theme-color"\s+content="#FFFFFF"\s+media="\(prefers-color-scheme:\s*light\)"\s*\/?>/,
    );
    expect(body).toMatch(
      /<meta\s+name="theme-color"\s+content="#0A0A0A"\s+media="\(prefers-color-scheme:\s*dark\)"\s*\/?>/,
    );
  });

  it("embeds the design tokens as CSS custom properties", async () => {
    const response = await exports.default.fetch(new Request("https://ratedwatch.test/"));
    const body = await response.text();

    // Accent, background, and text tokens must be present either inlined
    // or via a linked stylesheet. Asserting the canonical hex values
    // catches silent palette drops during refactors.
    expect(body).toContain("#000000"); // primary CTA accent (black pill)
    expect(body).toContain("#FFFFFF"); // canvas light
    expect(body).toContain("#0A0A0A"); // canvas dark (warm-neutral near-black)
  });

  it("renders the hero tagline", async () => {
    const response = await exports.default.fetch(new Request("https://ratedwatch.test/"));
    const body = await response.text();

    // The tagline anchors the home page and the social share card. It must
    // appear in the SSR output so crawlers and no-JS clients see it.
    expect(body).toMatch(/Competitive accuracy tracking/i);
  });

  it("teases leaderboards as the next thing to ship", async () => {
    const response = await exports.default.fetch(new Request("https://ratedwatch.test/"));
    const body = await response.text();
    expect(body).toMatch(/leaderboards/i);
  });

  it("emits zero client-side JavaScript — no <script> tags on /", async () => {
    const response = await exports.default.fetch(new Request("https://ratedwatch.test/"));
    const body = await response.text();

    // Public pages must be pure SSR — any <script> tag (classic, module,
    // JSON-LD excluded intentionally here) is a regression against the
    // "no hydration on public pages" contract.
    expect(body).not.toMatch(/<script\b/i);
  });

  it("respects prefers-color-scheme via a CSS media query", async () => {
    const response = await exports.default.fetch(new Request("https://ratedwatch.test/"));
    const body = await response.text();
    expect(body).toMatch(/prefers-color-scheme\s*:\s*dark/i);
  });

  // Followup (cache-vary-cookie): public SSR pages must emit
  // `Vary: Cookie` so browser caches correctly differentiate anon
  // vs authed variants after sign-out.
  it("emits Vary: Cookie and the anon s-maxage Cache-Control (no cookie)", async () => {
    const response = await exports.default.fetch(new Request("https://ratedwatch.test/"));
    expect(response.headers.get("vary") ?? "").toMatch(/Cookie/i);
    expect(response.headers.get("cache-control") ?? "").toMatch(/s-maxage=300/);
  });

  it("emits Vary: Cookie and the private signed-in Cache-Control when authenticated", async () => {
    // Register + sign in to acquire a Better Auth session cookie, then
    // hit the home page as that signed-in user. The public-pages
    // session resolver reads the same cookie via getSession.
    const email = `home-vary-${crypto.randomUUID()}@ratedwatch.test`;
    const password = "correct-horse-42";
    await exports.default.fetch(
      new Request("https://ratedwatch.test/api/v1/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "home-vary", email, password }),
      }),
    );
    const login = await exports.default.fetch(
      new Request("https://ratedwatch.test/api/v1/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
    expect(login.status).toBe(200);
    const rawCookie = login.headers.get("set-cookie") ?? "";
    const cookie = rawCookie.split(";")[0] ?? "";
    expect(cookie).toBeTruthy();

    const response = await exports.default.fetch(
      new Request("https://ratedwatch.test/", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("vary") ?? "").toMatch(/Cookie/i);
    expect(response.headers.get("cache-control") ?? "").toMatch(
      /private,\s*max-age=0,\s*must-revalidate/,
    );
  });
});
