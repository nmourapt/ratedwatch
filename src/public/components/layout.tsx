// Shared <Layout> for every public SSR page. Owns the <head>, the social
// share meta, and the single inlined stylesheet that gives public pages
// their design-system tokens. Public pages emit ZERO client JS — see the
// "no <script> tag" contract in tests/integration/home.test.ts.
//
// Fonts: we prefer the licensed CF Workers faces (FT Kunst Grotesk, Apercu
// Mono Pro) when they're available via self-hosted @font-face rules, but
// fall back to open alternatives (Geist Sans, JetBrains Mono) and finally
// to system sans/mono when no webfont is present. Slice 3 leaves the
// @font-face rules as TODOs — fonts land in a later slice once the licence
// + R2 bucket are ready. See ~/design/CF-WORKERS-DESIGN.md §3.
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
 * Emits the CF Workers design tokens as CSS custom properties, swapping
 * values at the `prefers-color-scheme: dark` breakpoint. Rendered once per
 * page in the <head>. Kept in this file because it's tightly coupled to
 * the <Layout> contract (tests assert the tokens appear in the response).
 */
function DesignTokensStyle() {
  const l = tokens.light;
  const d = tokens.dark;
  // Deliberately hand-rolled CSS string (not JSX) — hono/jsx escapes `<style>`
  // children otherwise. Dangerously-set-innerHTML is unavailable in hono/jsx;
  // the idiomatic approach is to pass the raw string as a child and rely on
  // hono/jsx's raw HTML insertion via the `html` helper, but a plain <style>
  // tag with static CSS text is fine since no user data flows in here.
  const css = `
:root {
  --cf-orange: ${l.orange};
  --cf-orange-hover: ${l.orangeHover};
  --cf-text: ${l.text};
  --cf-text-muted: ${l.textMuted};
  --cf-text-subtle: ${l.textSubtle};
  --cf-bg-page: ${l.bgPage};
  --cf-bg-100: ${l.bg100};
  --cf-bg-200: ${l.bg200};
  --cf-bg-300: ${l.bg300};
  --cf-border: ${l.border};
  --cf-border-light: ${l.borderLight};
  --cf-font-sans: ${tokens.font.sans};
  --cf-font-mono: ${tokens.font.mono};
  --cf-radius-sm: ${tokens.radius.sm};
  --cf-radius-md: ${tokens.radius.md};
  --cf-radius-lg: ${tokens.radius.lg};
  --cf-radius-xl: ${tokens.radius.xl};
  --cf-radius-full: ${tokens.radius.full};
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root {
    --cf-orange: ${d.orange};
    --cf-orange-hover: ${d.orangeHover};
    --cf-text: ${d.text};
    --cf-text-muted: ${d.textMuted};
    --cf-text-subtle: ${d.textSubtle};
    --cf-bg-page: ${d.bgPage};
    --cf-bg-100: ${d.bg100};
    --cf-bg-200: ${d.bg200};
    --cf-bg-300: ${d.bg300};
    --cf-border: ${d.border};
    --cf-border-light: ${d.borderLight};
    color-scheme: dark;
  }
}

*,
*::before,
*::after { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--cf-bg-100);
  color: var(--cf-text);
  font-family: var(--cf-font-sans);
  font-size: 16px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  font-feature-settings: "kern" 1, "liga" 1;
}

a {
  color: var(--cf-orange);
  text-decoration: none;
  transition: color 0.15s ease;
}
a:hover { color: var(--cf-orange-hover); }

:focus-visible {
  outline: 2px solid var(--cf-orange);
  outline-offset: 2px;
  border-radius: var(--cf-radius-sm);
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
  font-size: clamp(2.25rem, 4vw + 1rem, 3rem);
  line-height: 1.05;
  letter-spacing: -0.02em;
  margin: 0 0 16px;
  font-weight: 500;
}
.cf-hero p {
  max-width: 56ch;
  margin: 0 0 32px;
  color: var(--cf-text-muted);
  font-size: 1.125rem;
  line-height: 1.56;
}

.cf-section {
  padding: 48px 0;
  border-top: 1px dashed var(--cf-border);
}

.cf-card {
  position: relative;
  background: var(--cf-bg-200);
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-lg);
  padding: 24px;
}
.cf-card__title {
  margin: 0 0 8px;
  font-size: 1.5rem;
  font-weight: 500;
  letter-spacing: -0.02em;
}
.cf-card__body {
  margin: 0;
  color: var(--cf-text-muted);
}

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
  background: var(--cf-bg-100);
  border: 1px solid var(--cf-border);
  border-radius: 1.5px;
}
.cf-brackets::before { top: -4px; left: -4px; }
.cf-brackets::after { top: -4px; right: -4px; }
.cf-brackets > span::before { bottom: -4px; left: -4px; }
.cf-brackets > span::after { bottom: -4px; right: -4px; }

.cf-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 24px;
  border-radius: var(--cf-radius-full);
  font-family: var(--cf-font-sans);
  font-weight: 500;
  font-size: 1rem;
  line-height: 1;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background-color 0.16s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              color 0.16s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              border-color 0.16s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.cf-btn--primary {
  background: var(--cf-orange);
  color: #FFFBF5;
}
.cf-btn--primary:hover { background: var(--cf-orange-hover); color: #FFFBF5; }
.cf-btn--ghost {
  background: transparent;
  color: var(--cf-text);
  border-color: var(--cf-border);
}
.cf-btn--ghost:hover {
  background: var(--cf-bg-300);
  color: var(--cf-text);
}

.cf-header {
  border-bottom: 1px solid var(--cf-border);
  padding: 16px 0;
  background: var(--cf-bg-100);
}
.cf-header__inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.cf-logo {
  font-family: var(--cf-font-mono);
  font-size: 1rem;
  letter-spacing: -0.02em;
  color: var(--cf-text);
  font-weight: 500;
}
.cf-logo__accent { color: var(--cf-orange); }

.cf-nav {
  display: flex;
  gap: 24px;
  font-size: 0.875rem;
}
.cf-nav a { color: var(--cf-text-muted); }
.cf-nav a:hover { color: var(--cf-text); }

.cf-footer {
  border-top: 1px solid var(--cf-border);
  padding: 32px 0;
  color: var(--cf-text-subtle);
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
          content={tokens.light.bg100}
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="theme-color"
          content={tokens.dark.bg100}
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

        <DesignTokensStyle />
      </head>
      <body>{children}</body>
    </html>
  );
};
