// Button primitive for public SSR pages. Server-rendered only — this has
// no onClick / no hydration. For authed app interactions use the SPA-side
// button (to be added under src/app/ui/ later).
//
// Two variants in slice 3:
//   - "primary": accent fill, white text. CTAs.
//   - "ghost":   border + muted text. Secondary actions.
//
// The `as` prop lets the same styling apply to <a>, so link-buttons on the
// hero ("Browse leaderboards") can share the exact same classes.
import type { Child } from "hono/jsx";

export type ButtonVariant = "primary" | "ghost";

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
  return v === "ghost" ? "cf-btn cf-btn--ghost" : "cf-btn cf-btn--primary";
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
