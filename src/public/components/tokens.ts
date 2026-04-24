// Design tokens — single source of truth for palette, radii,
// typography, motion, and shadows used by both the public SSR pages
// and the SPA.
//
// Palette v4 — ElevenLabs-inspired warm-white + stone system.
// Semantic names only: `canvas`, `surface`, `surfaceInset`,
// `surfaceWarm`, `ink`, `inkMuted`, `inkSubtle`, `line`, `lineSubtle`,
// `accent`, `accentFg`. The `cf-*` prefix is gone — names now honestly
// describe role rather than vendor. See the bundled DESIGN.md in the
// repo root for rationale and the source spec.
//
// Light mode is a near-white canvas with a warm stone CTA signature
// (`rgba(245, 242, 239, 0.8)`). Dark mode is derived from that feel:
// warm-tinted off-black surfaces instead of cool zinc, with the
// accent inverting to an off-white pill.
//
// The matching CSS custom properties are emitted by
// <DesignTokensStyle /> in `layout.tsx` (public SSR) and by the
// `@theme` block in `src/app/styles.css` (SPA). Keep all three in
// sync.

export const tokens = {
  light: {
    // Primary page + card surfaces
    canvas: "#FFFFFF", // Pure white main background
    surface: "#F5F5F5", // Light gray card / section-break background
    surfaceInset: "#F6F6F6", // Inset (stats panels, input fills)
    surfaceWarm: "rgba(245, 242, 239, 0.8)", // Warm stone signature CTA surface
    shell: "#F5F5F5", // Rarely-used outer shell

    // Typography
    ink: "#000000", // Primary text / display headings
    inkMuted: "#4E4E4E", // Secondary / body copy
    inkSubtle: "#777169", // Warm-gray muted / decorative

    // Lines + borders
    line: "#E5E5E5", // Explicit borders
    lineSubtle: "rgba(0, 0, 0, 0.05)", // Ultra-subtle dividers

    // Interactive accent
    accent: "#000000", // Black primary CTA
    accentHover: "#1A1A1A", // Near-black hover lift
    accentFg: "#FFFFFF", // CTA text on black
  },
  dark: {
    // Derived warm-dark variant — unspecified in DESIGN.md, we interpret:
    // near-black canvas with a warm-tinted stone CTA (mirrors light
    // mode's warm signature). Shadows lose their punch on a dark
    // background so the layout leans on thin warm-gray rings instead
    // — see the shadow overrides in styles.css / layout.tsx.
    canvas: "#0A0A0A", // Near-black, warm enough not to feel cold
    surface: "#141414", // One step lighter
    surfaceInset: "#1C1C1C", // Inset
    surfaceWarm: "#1F1B16", // Warm-tinted dark CTA
    shell: "#000000", // Full black outer shell

    ink: "#FFFFFF",
    inkMuted: "#A8A29A", // Warm-gray echoing light-mode #777169
    inkSubtle: "#6B6561", // Deeper warm-gray for tertiary text

    line: "#2A2724", // Warm-ish border
    lineSubtle: "rgba(255, 255, 255, 0.05)",

    accent: "#F5F5F5", // Warm off-white pill
    accentHover: "#FFFFFF", // Brighter on hover
    accentFg: "#0A0A0A", // Near-black CTA text
  },
  font: {
    // Inter substitutes for Waldenburg (Google Fonts; licence-safe).
    // DESIGN.md calls for Waldenburg 300 as display — we map to
    // Inter 300 + tracking-tight to recover the ethereal feel.
    display:
      '"Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    body: '"Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    mono: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  },
  radius: {
    tight: "4px", // Tags, small inline
    md: "8px", // Standard containers
    lg: "12px", // Dropdowns, mid cards (kept for legacy call sites)
    card: "16px", // Cards, articles
    panel: "24px", // Large panels, section containers
    warmBtn: "30px", // Warm stone CTA
    pill: "9999px", // Primary pill buttons
  },
} as const;
