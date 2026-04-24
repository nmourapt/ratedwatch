import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";

// Tailwind v4 design-token regression guard — dark-mode shadow fix.
//
// Tailwind v4's @theme block in src/app/styles.css registers
// --shadow-<name> tokens, which Tailwind then emits as `.shadow-<name>`
// utility classes. The emitted utility BAKES THE LIGHT-MODE LITERAL
// in as the box-shadow fallback at build time:
//
//   .shadow-card { --tw-shadow: var(--tw-shadow-color, #0000000f) 0 0 0 1px, ...; }
//
// The @media (prefers-color-scheme: dark) block in styles.css redefines
// --shadow-<name> to warm-white rings, but Tailwind's emitted utility
// IGNORES that override because it was snapshotted at build time. So
// `shadow-card`, `hover:shadow-lift`, etc. show black-tinted shadows
// in dark mode — invisible on near-black surfaces.
//
// The fix: add `@utility shadow-<name> { box-shadow: var(--shadow-<name>); }`
// blocks after `:root { color-scheme: light; }` so each used utility
// (and its variants) reads the runtime CSS var. The override emerges
// later in the cascade than the @theme-generated rule and Tailwind
// keeps `--shadow-*` available as :root custom properties, so the
// dark-mode @media block applies. This test asserts those overrides
// made it into the production CSS bundle.
//
// Scope: only the utilities ACTUALLY used as Tailwind classes in
// src/app/**/*.tsx need overriding. shadow-warm/soft/outline are only
// referenced via `.cf-*` classes that already do box-shadow:
// var(--shadow-X) directly, so they are dark-mode-correct already.
//
// Note on Tailwind's lazy emission: Tailwind only emits the `.shadow-X`
// rule for utilities that actually appear in source files. The current
// codebase uses `shadow-card` and `shadow-inset-edge` directly but only
// `hover:shadow-lift` (no bare `shadow-lift`), so we assert overrides
// for the three SHAPES present in the build: `.shadow-card`,
// `.shadow-inset-edge`, and `.hover\:shadow-lift:hover`. The bare
// `.shadow-lift` rule is ALSO registered via @utility for parity
// (future-proofing a non-hover use) but Tailwind won't emit it until
// some source file references the bare class — this test deliberately
// does NOT require a bare `.shadow-lift` rule in the bundle, because
// asserting absence of an unused utility is a flake risk.

let cssBody: string;

beforeAll(async () => {
  const shellResponse = await env.ASSETS.fetch(
    new Request("https://ratedwatch.test/app/dashboard"),
  );
  const shell = await shellResponse.text();
  const match = shell.match(/<link[^>]+rel="stylesheet"[^>]+href="(\/assets\/[^"]+)"/);
  if (!match) throw new Error("no stylesheet link in SPA shell");
  const cssHref = match[1]!;

  const cssResponse = await env.ASSETS.fetch(
    new Request(`https://ratedwatch.test${cssHref}`),
  );
  expect(cssResponse.status).toBe(200);
  cssBody = await cssResponse.text();
});

describe("Shadow utility dark-mode override", () => {
  // Each assertion looks for a rule matching `<selector> { box-shadow:
  // var(--shadow-<name>); }` (allowing for minified whitespace and
  // additional declarations in the same block). The presence of this
  // override bypasses Tailwind's snapshotted literal and lets the
  // @media (prefers-color-scheme: dark) block in styles.css take effect.

  it(".shadow-card reads from var(--shadow-card) at runtime", () => {
    expect(cssBody).toMatch(
      /\.shadow-card\s*\{[^}]*box-shadow\s*:\s*var\s*\(\s*--shadow-card\s*\)[^}]*\}/,
    );
  });

  it(".shadow-inset-edge reads from var(--shadow-inset-edge) at runtime", () => {
    expect(cssBody).toMatch(
      /\.shadow-inset-edge\s*\{[^}]*box-shadow\s*:\s*var\s*\(\s*--shadow-inset-edge\s*\)[^}]*\}/,
    );
  });

  it("hover:shadow-lift variant reads from var(--shadow-lift) at runtime", () => {
    // GoogleSignInButton uses `hover:shadow-lift`. Tailwind escapes the
    // colon in the selector, so the emitted class is
    // `.hover\:shadow-lift:hover`. The escape is a literal backslash in
    // the CSS source, which we match with `\\:` in the regex.
    expect(cssBody).toMatch(
      /\.hover\\:shadow-lift:hover\s*\{[^}]*box-shadow\s*:\s*var\s*\(\s*--shadow-lift\s*\)[^}]*\}/,
    );
  });

  // Sanity: the dark-mode @media block must still be present — that's
  // what redefines --shadow-<name>, which our overrides now read.
  it("dark-mode media query redefines --shadow-lift to warm-white rings", () => {
    expect(cssBody).toMatch(/prefers-color-scheme\s*:\s*dark/i);
    // The dark --shadow-lift uses rgba(255,255,255,...) which Tailwind
    // does NOT minify into a hex (alpha channel). Its first colour
    // stop is rgba(255, 255, 255, 0.08) — minifier may compact to
    // #ffffff14 or rgba(255,255,255,.08).
    expect(cssBody).toMatch(/(#ffffff14|rgba\(255,\s*255,\s*255,\s*\.?0?\.08\))/);
  });
});
