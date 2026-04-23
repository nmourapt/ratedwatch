// CF Workers design tokens — single source of truth for palette, radii,
// typography, and motion used by both the public SSR pages and the SPA.
//
// We expose the raw hex/token values here (not a CSS string) so components
// that render inline colour (e.g. the <meta name="theme-color">) don't have
// to grep out of a stylesheet. The matching CSS custom properties are
// emitted by `<DesignTokensStyle />` in `layout.tsx`.
//
// See ~/design/CF-WORKERS-DESIGN.md §2 and §3 for the full reference.

export const tokens = {
  light: {
    orange: "#FF4801",
    orangeHover: "#FF7038",
    text: "#521000",
    textMuted: "rgba(82, 16, 0, 0.6)",
    textSubtle: "rgba(82, 16, 0, 0.38)",
    bgPage: "#F5F1EB",
    bg100: "#FFFBF5",
    bg200: "#FFFDFB",
    bg300: "#FEF7ED",
    border: "#EBD5C1",
    borderLight: "rgba(235, 213, 193, 0.5)",
  },
  dark: {
    orange: "#F14602",
    orangeHover: "#FF6D33",
    text: "#F0E3DE",
    textMuted: "rgba(255, 253, 251, 0.56)",
    textSubtle: "rgba(255, 253, 251, 0.38)",
    bgPage: "#0D0D0D",
    bg100: "#121212",
    bg200: "#191817",
    bg300: "#2A2927",
    border: "rgba(240, 227, 222, 0.13)",
    borderLight: "rgba(240, 227, 222, 0.08)",
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
