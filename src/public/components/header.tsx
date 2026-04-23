// Public site header — logo + top-level nav. All links are real paths; the
// ones that don't exist yet (leaderboard, app) 404/SPA-fallback gracefully.
// Slice 3 is just the shell; destinations land in slices 4 onwards.
export const Header = () => (
  <header class="cf-header">
    <div class="cf-container cf-header__inner">
      <a href="/" class="cf-logo" aria-label="rated.watch home">
        rated<span class="cf-logo__accent">.</span>watch
      </a>
      <nav class="cf-nav" aria-label="Primary">
        <a href="/leaderboard">Leaderboard</a>
        <a href="/app/login">Sign in</a>
      </nav>
    </div>
  </header>
);
