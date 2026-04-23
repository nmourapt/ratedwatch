import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

// The authed SPA lives at /app/*. Workers Assets serves the built
// dist/index.html for every unknown path thanks to
// not_found_handling=single-page-application, so the four placeholder
// routes (/app/login, /app/register, /app/dashboard, /app/settings)
// must each resolve to the SPA shell HTML. The SPA's client router
// then renders the right placeholder page.
//
// In production the request flow is:
//   request → CF assets layer → (no file match) → 200 with /index.html
// The Worker's default handler only owns `/` and `/api/*` via
// run_worker_first, so we test the assets layer directly through the
// ASSETS binding instead of exports.default.fetch (which bypasses
// assets routing — see vitest-pool-workers docs).

const routes = [
  "/app/login",
  "/app/register",
  "/app/dashboard",
  "/app/settings",
];

describe("SPA shell — /app/*", () => {
  for (const path of routes) {
    it(`GET ${path} falls through to the SPA shell via Workers Assets`, async () => {
      const response = await env.ASSETS.fetch(
        new Request(`https://ratedwatch.test${path}`),
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      // The shell is dist/index.html, which mounts React at #root.
      expect(body).toContain(`id="root"`);
    });
  }

  it("SPA shell links a stylesheet (design-system CSS is wired)", async () => {
    const response = await env.ASSETS.fetch(
      new Request("https://ratedwatch.test/app/dashboard"),
    );
    const body = await response.text();
    // Vite emits <link rel="stylesheet" href="/assets/..."> when the SPA
    // imports a .css file. Presence of at least one stylesheet link is
    // the minimum proof that Tailwind / the tokens CSS is part of the
    // production bundle.
    expect(body).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="\/assets\//);
  });
});
