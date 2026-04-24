// Public site header — logo + session-aware nav.
//
// When an anonymous visitor hits /, /leaderboard, /m/:id, /u/:name,
// or /w/:id they see the generic Leaderboard + Sign in links. When a
// signed-in visitor hits the same pages they see Leaderboard +
// `@username → /app/dashboard` — so clicking around the public
// surface doesn't feel like a logout.
//
// Session shape is imported rather than duplicated so a future
// change to the public session slice (e.g. adding a display name)
// propagates to both the helper and the header without touching
// every call site.
import type { PublicSessionUser } from "@/public/auth/resolve-session";

export interface HeaderProps {
  /**
   * Resolved session user, or null for anonymous visitors. Defaults
   * to null so routes that haven't been updated to pass session
   * state still render the anonymous nav (graceful fall-through).
   */
  user?: PublicSessionUser | null;
}

export const Header = ({ user = null }: HeaderProps) => (
  <header class="cf-header">
    <div class="cf-container cf-header__inner">
      <a href="/" class="cf-logo" aria-label="rated.watch home">
        rated<span class="cf-logo__accent">.</span>watch
      </a>
      <nav class="cf-nav" aria-label="Primary">
        <a href="/leaderboard">Leaderboard</a>
        {user ? (
          <a href="/app/dashboard" aria-label="Back to your dashboard">
            @{user.username ?? "you"}
          </a>
        ) : (
          <a href="/app/login">Sign in</a>
        )}
      </nav>
    </div>
  </header>
);
