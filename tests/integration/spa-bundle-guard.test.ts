import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";

// SPA bundle-guard tests — integrity checks that would have caught the
// slice 3 → slice 22b regression where Vite's @vitejs/plugin-react was
// inheriting `jsxImportSource: "hono/jsx"` from the Worker-side
// tsconfig. The production SPA then bundled Hono's JSX factory
// (HtmlEscapedString) instead of React.createElement, rendering blank
// in the browser. The existing spa-shell.test.ts didn't catch it —
// those tests assert HTML shell + CSS + specific strings, but never
// the React runtime itself.
//
// Cheap regex-based inspection of the built JS bundle. No DOM, no
// bundle execution. Two classes of assertion:
//
//   1. Positive markers — proof React IS in the bundle.
//   2. Negative markers — proof Hono JSX is NOT in the bundle.
//
// Both regress together when jsxImportSource drifts. If either fails,
// you've likely changed the Vite JSX runtime config.

let spaBundle: string;

beforeAll(async () => {
  const shell = await env.ASSETS.fetch(new Request("https://ratedwatch.test/app/login"));
  const shellBody = await shell.text();
  const match = shellBody.match(/<script[^>]+type="module"[^>]+src="(\/assets\/[^"]+)"/);
  if (!match) throw new Error("no module script tag in SPA shell");
  const jsHref = match[1]!;

  const jsResponse = await env.ASSETS.fetch(
    new Request(`https://ratedwatch.test${jsHref}`),
  );
  expect(jsResponse.status).toBe(200);
  spaBundle = await jsResponse.text();
});

describe("SPA bundle guard — JSX runtime is React, not hono/jsx", () => {
  // React's minified output reliably contains these Symbol descriptors.
  // They're used by the React reconciler to tag virtual-DOM nodes and
  // survive any reasonable bundler minification intact — Vite's
  // minifier (rolldown) doesn't rename string literals.
  it("contains React element Symbol markers", () => {
    // React 19 uses "react.transitional.element" during the 18→19
    // migration window; both are valid signals the React runtime was
    // bundled.
    const reactMarkerRe = /react\.(transitional\.)?element/;
    expect(spaBundle).toMatch(reactMarkerRe);
  });

  it("contains React reconciler entrypoints", () => {
    // react-dom's client entrypoint is createRoot. The string is user
    // API; always present in any React 18/19 SPA.
    expect(spaBundle).toContain("createRoot");
  });

  it("does NOT contain hono/jsx markers", () => {
    // HtmlEscapedString is Hono's JSX output type. If this string
    // appears in the SPA bundle, @vitejs/plugin-react has been told
    // to use hono/jsx as the JSX runtime — which means the React
    // page code compiled to Hono's string-building factory instead of
    // React.createElement. SPA renders blank in production. The
    // fix is `react({ jsxImportSource: "react" })` in vite.config.ts.
    //
    // Note: the Worker code (src/worker/**, src/public/**) DOES use
    // HtmlEscapedString legitimately, but the Worker is a separate
    // bundle. The SPA bundle must be free of this token.
    expect(spaBundle).not.toContain("HtmlEscapedString");
  });

  it("does NOT contain hono/jsx runtime import specifier", () => {
    // If Vite is resolving hono/jsx's JSX runtime, the bundle includes
    // paths under `hono/jsx/jsx-runtime` or similar. They shouldn't
    // appear in a pure React SPA bundle.
    expect(spaBundle).not.toMatch(/hono\/jsx(\/jsx-(dev-)?runtime)?/);
  });

  it("mounts React at the shell's #root", () => {
    // main.tsx does `createRoot(document.getElementById("root"))…`.
    // The literal "root" survives minification because it's a DOM
    // string. Rolldown rewrites all string literals to backtick form,
    // so we accept any of the three quote styles.
    expect(spaBundle).toMatch(/getElementById\([`"']root[`"']\)/);
  });
});
