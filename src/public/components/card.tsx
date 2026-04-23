// Card primitive with the signature CF Workers corner-bracket decoration.
// The four 8px squares sit outside the border radius — purely decorative,
// rendered via ::before/::after pseudo-elements on an absolutely-positioned
// overlay. See ~/design/CF-WORKERS-DESIGN.md §11.1.
//
// The `corners` prop defaults to true because ~every card in the design
// uses them. Pass `corners={false}` to opt out (e.g. on a card inside a
// bigger bracketed container).
import type { Child } from "hono/jsx";

export type CardProps = {
  title?: string;
  children: Child;
  corners?: boolean;
  class?: string;
};

export const Card = ({ title, children, corners = true, class: className }: CardProps) => (
  <div class={`cf-card${className ? ` ${className}` : ""}`}>
    {corners ? (
      <div class="cf-brackets" aria-hidden="true">
        <span />
      </div>
    ) : null}
    {title ? <h2 class="cf-card__title">{title}</h2> : null}
    <div class="cf-card__body">{children}</div>
  </div>
);
