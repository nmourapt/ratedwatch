// Button primitive for public SSR pages. Server-rendered only — this has
// no onClick / no hydration. For authed app interactions use the SPA-side
// button (to be added under src/app/ui/ later).
//
// Three variants under palette v4 (ElevenLabs warm-white):
//   - "primary": black pill (light) / off-white pill (dark). Primary CTA.
//   - "ghost":   white pill with shadow-lift border. Secondary.
//   - "warm":    warm stone pill with warm-tinted shadow. The signature
//                ElevenLabs CTA. Use for the most prominent action on a
//                page (hero "Browse leaderboards", "Shop on Chrono24").
//
// Styling lives in src/public/components/layout.tsx under .cf-btn—* —
// those class names are internal CSS selectors, not design tokens.
//
// The `as` prop lets the same styling apply to <a>, so link-buttons on
// the hero share identical classes.
import type { Child } from "hono/jsx";

export type ButtonVariant = "primary" | "ghost" | "warm";

type BaseProps = {
  variant?: ButtonVariant;
  children: Child;
  class?: string;
};

type ButtonProps = BaseProps & {
  as?: "button";
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
};

type LinkProps = BaseProps & {
  as: "a";
  href: string;
  target?: "_self" | "_blank";
  rel?: string;
};

function variantClass(v: ButtonVariant | undefined): string {
  if (v === "warm") return "cf-btn cf-btn--warm";
  if (v === "ghost") return "cf-btn cf-btn--ghost";
  return "cf-btn cf-btn--primary";
}

export const Button = (props: ButtonProps | LinkProps) => {
  const cls = `${variantClass(props.variant)}${props.class ? ` ${props.class}` : ""}`;
  if (props.as === "a") {
    return (
      <a
        class={cls}
        href={props.href}
        target={props.target}
        rel={props.target === "_blank" ? (props.rel ?? "noreferrer") : props.rel}
      >
        {props.children}
      </a>
    );
  }
  return (
    <button class={cls} type={props.type ?? "button"} disabled={props.disabled}>
      {props.children}
    </button>
  );
};
