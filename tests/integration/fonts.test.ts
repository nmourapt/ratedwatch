import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";

// Self-hosted fonts contract. Inter (300/400/500/600) and Geist Mono
// (400/500) ship out of /fonts/*.woff2 via Workers Assets rather than
// Google Fonts CDN. This eliminates a first-paint third-party DNS/TLS
// handshake and keeps all CSP/font sources first-party.
//
// Files live at src/app/public/fonts/*.woff2; Vite copies its `public`
// directory into dist/ at build time so Workers Assets serves them at
// /fonts/<file>. The worker does NOT own /fonts/* (wrangler.jsonc's
// run_worker_first list) so requests fall through to ASSETS, which is
// what we hit via env.ASSETS.fetch() below.

const FONT_FILES = [
  "Inter-Light.woff2",
  "Inter-Regular.woff2",
  "Inter-Medium.woff2",
  "Inter-SemiBold.woff2",
  "GeistMono-Regular.woff2",
  "GeistMono-Medium.woff2",
] as const;

describe("Self-hosted fonts", () => {
  for (const file of FONT_FILES) {
    it(`GET /fonts/${file} returns 200 from Workers Assets`, async () => {
      const response = await env.ASSETS.fetch(
        new Request(`https://ratedwatch.test/fonts/${file}`),
      );
      expect(response.status).toBe(200);
      // Workers Assets sets `font/woff2` for .woff2 extensions, but
      // some runtimes/tools fall back to application/octet-stream.
      // Accept either — what matters is that the byte stream is served.
      const contentType = response.headers.get("content-type") ?? "";
      expect(contentType).toMatch(/font\/woff2|application\/octet-stream/);
      // Sanity-check the body isn't empty — these are real binary files.
      const buf = await response.arrayBuffer();
      expect(buf.byteLength).toBeGreaterThan(1000);
    });
  }

  it("public home page references self-hosted /fonts/ URLs, never Google Fonts", async () => {
    const response = await exports.default.fetch(new Request("https://ratedwatch.test/"));
    expect(response.status).toBe(200);
    const body = await response.text();

    // No third-party font hostnames in the HTML — this is the whole
    // point of the change. Both the stylesheet @import and the
    // preconnect links must be gone.
    expect(body).not.toContain("fonts.googleapis.com");
    expect(body).not.toContain("fonts.gstatic.com");

    // Inline @font-face block must reference the self-hosted paths.
    expect(body).toMatch(/@font-face\s*{[^}]*url\(["']?\/fonts\//);
  });

  it("public home page preloads the body font (Inter-Regular) with crossorigin", async () => {
    const response = await exports.default.fetch(new Request("https://ratedwatch.test/"));
    const body = await response.text();

    // Preload only the ONE most-used weight (400). Preloading every
    // font is an anti-pattern — the browser will discover the others
    // once @font-face is parsed.
    expect(body).toMatch(
      /<link[^>]+rel="preload"[^>]+href="\/fonts\/Inter-Regular\.woff2"[^>]*>/,
    );
    // Fonts are always CORS-fetched, so the preload must carry the
    // crossorigin attribute — without it the browser fires a second
    // request and the preload is wasted.
    const preloadTag = body.match(
      /<link[^>]+rel="preload"[^>]+href="\/fonts\/Inter-Regular\.woff2"[^>]*>/,
    )?.[0];
    expect(preloadTag).toBeDefined();
    expect(preloadTag!).toMatch(/crossorigin/);
  });
});
