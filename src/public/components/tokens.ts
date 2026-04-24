// Design tokens — single source of truth for palette, radii,
// typography, and motion used by both the public SSR pages and the SPA.
//
// Palette v3: cool-neutral zinc family, no warm accent. Names are
// semantic (`accent`, `bg`, `surface`, `surfaceInset`, `shell`) and
// deliberately avoid hue-based labels — the actual hex values are
// zinc-family (mid-charcoal CTA light / near-white CTA dark). A
// historical rename from `orange`/`bg100-300`/`bgPage` to these
// semantic names happened in one commit — see git blame on this file.
//
// The matching CSS custom properties are emitted by
// <DesignTokensStyle /> in `layout.tsx` (public SSR) and by the
// `@theme` block in `src/app/styles.css` (SPA). Keep all three in
// sync.

export const tokens = {
  light: {
    accent: "#3F3F46", // zinc-700, primary CTA
    accentHover: "#27272A", // zinc-800
    text: "#18181B", // zinc-900
    textMuted: "#71717A", // zinc-500
    textSubtle: "#A1A1AA", // zinc-400
    shell: "#F4F4F5", // zinc-100, outer shell
    bg: "#FAFAFA", // zinc-50, main content
    surface: "#FFFFFF", // pure white, cards
    surfaceInset: "#F4F4F5", // zinc-100, inset
    border: "#E4E4E7", // zinc-200
    borderLight: "rgba(228, 228, 231, 0.5)",
  },
  dark: {
    accent: "#E4E4E7", // zinc-200, CTA inverted
    accentHover: "#FAFAFA", // zinc-50
    text: "#FAFAFA", // zinc-50
    textMuted: "#A1A1AA", // zinc-400
    textSubtle: "#71717A", // zinc-500
    shell: "#000000", // full black outer shell
    bg: "#09090B", // zinc-950, page
    surface: "#18181B", // zinc-900, cards
    surfaceInset: "#27272A", // zinc-800, inset
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
