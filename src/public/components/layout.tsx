// Shared <Layout> for every public SSR page. Owns the <head>, the social
// share meta, and the single inlined stylesheet that gives public pages
// their design-system tokens. Public pages emit ZERO client JS — see the
// "no <script> tag" contract in tests/integration/home.test.ts.
//
// Fonts: Inter (weights 300/400/500/600) substitutes for the commercial
// Waldenburg family called for in DESIGN.md. Loaded from Google Fonts
// via <link> tags so both SSR pages and the SPA share the same source.
// Geist Mono covers the mono slot. The licence-safe substitution is
// documented in DESIGN.md in the repo root.
//
// CSS variables use semantic names (`--color-canvas`, `--color-ink`,
// `--color-line`, `--color-accent`, …) — no `cf-*` prefix. Values match
// `@theme` in src/app/styles.css and the `tokens` object in tokens.ts.
import type { Child } from "hono/jsx";
import { tokens } from "./tokens";

export type LayoutProps = {
  title: string;
  description: string;
  /** Path relative to origin, used for og:url. No leading origin please. */
  pathname?: string;
  children: Child;
};

/**
 * Emits the design tokens as CSS custom properties, swapping values at
 * the `prefers-color-scheme: dark` breakpoint. Rendered once per page
 * in the <head>. Kept in this file because it's tightly coupled to the
 * <Layout> contract (tests assert tokens appear in the response).
 */
function DesignTokensStyle() {
  const l = tokens.light;
  const d = tokens.dark;
  // Hand-rolled CSS string — hono/jsx escapes <style> children
  // otherwise. Static text only; no user data flows in.
  const css = `
:root {
  --color-canvas: ${l.canvas};
  --color-surface: ${l.surface};
  --color-surface-inset: ${l.surfaceInset};
  --color-surface-warm: ${l.surfaceWarm};
  --color-shell: ${l.shell};
  --color-ink: ${l.ink};
  --color-ink-muted: ${l.inkMuted};
  --color-ink-subtle: ${l.inkSubtle};
  --color-line: ${l.line};
  --color-line-subtle: ${l.lineSubtle};
  --color-accent: ${l.accent};
  --color-accent-hover: ${l.accentHover};
  --color-accent-fg: ${l.accentFg};

  --shadow-inset-edge: rgba(0, 0, 0, 0.075) 0 0 0 0.5px inset;
  --shadow-outline: rgba(0, 0, 0, 0.06) 0 0 0 1px;
  --shadow-soft: rgba(0, 0, 0, 0.04) 0 4px 4px;
  --shadow-card: rgba(0, 0, 0, 0.06) 0 0 0 1px, rgba(0, 0, 0, 0.04) 0 1px 2px, rgba(0, 0, 0, 0.04) 0 2px 4px;
  --shadow-lift: rgba(0, 0, 0, 0.4) 0 0 1px, rgba(0, 0, 0, 0.04) 0 4px 4px;
  --shadow-warm: rgba(78, 50, 23, 0.04) 0 6px 16px;

  --font-display: ${tokens.font.display};
  --font-body: ${tokens.font.body};
  --font-mono: ${tokens.font.mono};

  --radius-tight: ${tokens.radius.tight};
  --radius-md: ${tokens.radius.md};
  --radius-lg: ${tokens.radius.lg};
  --radius-card: ${tokens.radius.card};
  --radius-panel: ${tokens.radius.panel};
  --radius-warm-btn: ${tokens.radius.warmBtn};
  --radius-pill: ${tokens.radius.pill};

  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-canvas: ${d.canvas};
    --color-surface: ${d.surface};
    --color-surface-inset: ${d.surfaceInset};
    --color-surface-warm: ${d.surfaceWarm};
    --color-shell: ${d.shell};
    --color-ink: ${d.ink};
    --color-ink-muted: ${d.inkMuted};
    --color-ink-subtle: ${d.inkSubtle};
    --color-line: ${d.line};
    --color-line-subtle: ${d.lineSubtle};
    --color-accent: ${d.accent};
    --color-accent-hover: ${d.accentHover};
    --color-accent-fg: ${d.accentFg};

    /* Dark-mode shadows: swap black for thin warm-white rings —
     * black shadows vanish on near-black surfaces. */
    --shadow-inset-edge: rgba(255, 255, 255, 0.04) 0 0 0 0.5px inset;
    --shadow-outline: rgba(255, 255, 255, 0.05) 0 0 0 1px;
    --shadow-card: rgba(255, 255, 255, 0.05) 0 0 0 1px, rgba(0, 0, 0, 0.3) 0 1px 2px, rgba(0, 0, 0, 0.3) 0 2px 4px;
    --shadow-lift: rgba(255, 255, 255, 0.08) 0 0 1px, rgba(0, 0, 0, 0.5) 0 4px 4px;
    --shadow-warm: rgba(78, 50, 23, 0.2) 0 6px 16px;

    color-scheme: dark;
  }
}

*,
*::before,
*::after { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--color-canvas);
  color: var(--color-ink);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.5;
  letter-spacing: 0.01em;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  font-feature-settings: "kern" 1, "liga" 1;
}

a {
  color: var(--color-ink);
  text-decoration: none;
  transition: color 0.15s ease, opacity 0.15s ease;
}
a:hover { color: var(--color-ink-muted); }

:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
  border-radius: var(--radius-tight);
}

.cf-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 24px;
}

.cf-hero {
  padding: 96px 0 64px;
}
.cf-hero h1 {
  font-family: var(--font-display);
  font-size: clamp(2.25rem, 4vw + 1rem, 3rem);
  line-height: 1.08;
  letter-spacing: -0.02em;
  margin: 0 0 16px;
  font-weight: 300;
}
.cf-hero p {
  max-width: 56ch;
  margin: 0 0 32px;
  color: var(--color-ink-muted);
  font-size: 1.125rem;
  line-height: 1.6;
  letter-spacing: 0.01em;
}

.cf-section {
  padding: 48px 0;
  border-top: 1px solid var(--color-line-subtle);
}

.cf-card {
  position: relative;
  background: var(--color-canvas);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-card);
  padding: 24px;
  box-shadow: var(--shadow-card);
}
.cf-card__title {
  margin: 0 0 8px;
  font-family: var(--font-display);
  font-size: 1.5rem;
  font-weight: 300;
  letter-spacing: -0.01em;
}
.cf-card__body {
  margin: 0;
  color: var(--color-ink-muted);
}

/* Corner brackets — decorative marker kept from the previous design
 * because the home + user pages use it. The ElevenLabs language is
 * restraint-first, so the brackets default to the subtle line colour. */
.cf-brackets {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.cf-brackets::before,
.cf-brackets::after,
.cf-brackets > span::before,
.cf-brackets > span::after {
  content: "";
  position: absolute;
  width: 8px;
  height: 8px;
  background: var(--color-canvas);
  border: 1px solid var(--color-line);
  border-radius: 1.5px;
}
.cf-brackets::before { top: -4px; left: -4px; }
.cf-brackets::after { top: -4px; right: -4px; }
.cf-brackets > span::before { bottom: -4px; left: -4px; }
.cf-brackets > span::after { bottom: -4px; right: -4px; }

/* Buttons: pill-shaped. Three variants —
 *   .cf-btn--primary : black pill (light) / warm-white pill (dark)
 *   .cf-btn--ghost   : white pill with shadow-lift border
 *   .cf-btn--warm    : warm stone CTA — DESIGN.md signature */
.cf-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 20px;
  border-radius: var(--radius-pill);
  font-family: var(--font-body);
  font-weight: 500;
  font-size: 0.9375rem; /* 15px */
  line-height: 1;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background-color 0.16s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              color 0.16s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              box-shadow 0.16s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              border-color 0.16s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.cf-btn--primary {
  background: var(--color-accent);
  color: var(--color-accent-fg);
}
.cf-btn--primary:hover {
  opacity: 0.88;
  color: var(--color-accent-fg);
}
.cf-btn--ghost {
  background: var(--color-canvas);
  color: var(--color-ink);
  box-shadow: var(--shadow-card);
}
.cf-btn--ghost:hover {
  box-shadow: var(--shadow-lift);
  color: var(--color-ink);
}
.cf-btn--warm {
  background: var(--color-surface-warm);
  color: var(--color-ink);
  border-radius: var(--radius-warm-btn);
  padding: 12px 20px 12px 14px;
  box-shadow: var(--shadow-warm);
}
.cf-btn--warm:hover {
  color: var(--color-ink);
  box-shadow: var(--shadow-warm), var(--shadow-card);
}

.cf-header {
  border-bottom: 1px solid var(--color-line-subtle);
  padding: 16px 0;
  background: var(--color-canvas);
  position: sticky;
  top: 0;
  z-index: 50;
}
.cf-header__inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.cf-logo {
  font-family: var(--font-mono);
  font-size: 1rem;
  letter-spacing: -0.02em;
  color: var(--color-ink);
  font-weight: 500;
}
.cf-logo__accent { color: var(--color-ink-subtle); }

.cf-nav {
  display: flex;
  gap: 24px;
  font-size: 0.9375rem;
  font-weight: 500;
}
.cf-nav a { color: var(--color-ink-muted); }
.cf-nav a:hover { color: var(--color-ink); }

.cf-footer {
  border-top: 1px solid var(--color-line-subtle);
  padding: 32px 0;
  color: var(--color-ink-subtle);
  font-size: 0.875rem;
}
.cf-footer__inner {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  justify-content: space-between;
  align-items: center;
}

.cf-grid-2 {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}
@media (min-width: 768px) {
  .cf-grid-2 { grid-template-columns: repeat(2, 1fr); gap: 24px; }
}
`;
  return <style>{css}</style>;
}

export const Layout = ({ title, description, pathname, children }: LayoutProps) => {
  const url = pathname ? `https://rated.watch${pathname}` : "https://rated.watch/";
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={description} />

        {/* Dual theme-color so browser chrome matches the palette in both
            schemes. Tests assert both tags are present. */}
        <meta
          name="theme-color"
          content={tokens.light.canvas}
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="theme-color"
          content={tokens.dark.canvas}
          media="(prefers-color-scheme: dark)"
        />

        {/* Open Graph + Twitter card for share previews. */}
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={url} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={description} />

        <link rel="canonical" href={url} />

        {/* Font loading — Inter for display+body, Geist Mono for code.
            Preconnect to both Google Fonts domains to trim latency. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Geist+Mono:wght@400;500&display=swap"
        />

        <DesignTokensStyle />
      </head>
      <body>{children}</body>
    </html>
  );
};
