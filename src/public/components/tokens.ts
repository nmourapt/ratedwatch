// Design tokens — single source of truth for palette, radii,
// typography, and motion used by both the public SSR pages and the SPA.
//
// Palette v3: cool-neutral zinc family, no warm accent. Token names
// still reference "orange" for minimum repo churn — actual hex values
// are zinc-family (mid-charcoal CTA light / near-white CTA dark).
// Semantic rename (orange → accent) is a followup.
//
// The matching CSS custom properties are emitted by
// <DesignTokensStyle /> in `layout.tsx` (public SSR) and by the
// `@theme` block in `src/app/styles.css` (SPA). Keep all three in
// sync.

export const tokens = {
  light: {
    orange: "#3F3F46", // zinc-700, primary CTA
    orangeHover: "#27272A", // zinc-800
    text: "#18181B", // zinc-900
    textMuted: "#71717A", // zinc-500
    textSubtle: "#A1A1AA", // zinc-400
    bgPage: "#F4F4F5", // zinc-100, outer shell
    bg100: "#FAFAFA", // zinc-50, main content
    bg200: "#FFFFFF", // pure white, cards
    bg300: "#F4F4F5", // zinc-100, inset
    border: "#E4E4E7", // zinc-200
    borderLight: "rgba(228, 228, 231, 0.5)",
  },
  dark: {
    orange: "#E4E4E7", // zinc-200, CTA inverted
    orangeHover: "#FAFAFA", // zinc-50
    text: "#FAFAFA", // zinc-50
    textMuted: "#A1A1AA", // zinc-400
    textSubtle: "#71717A", // zinc-500
    bgPage: "#000000", // full black outer shell
    bg100: "#09090B", // zinc-950, page
    bg200: "#18181B", // zinc-900, cards
    bg300: "#27272A", // zinc-800, inset
    border: "#27272A", // zinc-800
    borderLight: "rgba(39, 39, 42, 0.5)",
  },
  font: {
    sans: '"FT Kunst Grotesk", "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    mono: '"Apercu Mono Pro", "JetBrains Mono", "SF Mono", "Fira Code", Consolas, monospace',
  },
  radius: {
    sm: "4px",
    md: "8px",
    lg: "12px",
    xl: "16px",
    full: "9999px",
  },
} as const;
