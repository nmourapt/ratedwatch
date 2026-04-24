// Authed SPA chrome. Renders the SPA-side header/footer and an <Outlet />
// for the routed page. Nav pulls in the public Leaderboard so signed-in
// users don't have to leave the app surface to see rankings — the old
// "← Site" link exited the SPA to the public landing page and felt like
// a logout (the Better Auth cookie stayed set, but the public header
// showed anonymous affordances so visitors perceived themselves as
// signed out). That flow is fixed in two places:
//
//   1. Here: "← Site" was replaced with a plain "Leaderboard" link that
//      keeps the same framing as the other SPA nav items.
//   2. src/public/components/header.tsx: the public Header now reads
//      the Better Auth session and swaps its "Sign in" affordance for
//      "@username → /app/dashboard" when a session exists. So round-
//      tripping from /app/* to the public site and back no longer
//      strands the user.
import { Link, Outlet } from "react-router";

export function App() {
  return (
    <div className="min-h-screen flex flex-col bg-canvas text-ink font-sans">
      <header className="border-b border-line bg-canvas">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4 px-6 py-4">
          <Link
            to="/app"
            className="font-mono text-base font-medium tracking-tight text-ink hover:text-ink"
            aria-label="rated.watch app home"
          >
            rated<span className="text-accent">.</span>watch
          </Link>
          <nav aria-label="App primary" className="flex gap-6 text-sm text-ink-muted">
            <Link to="/app/dashboard" className="hover:text-ink">
              Dashboard
            </Link>
            <a href="/leaderboard" className="hover:text-ink">
              Leaderboard
            </a>
            <Link to="/app/settings" className="hover:text-ink">
              Settings
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <div className="mx-auto max-w-[1200px] px-6 py-12">
          <Outlet />
        </div>
      </main>
      <footer className="border-t border-line py-8 text-sm text-ink-subtle">
        <div className="mx-auto max-w-[1200px] px-6">
          rated.watch — authed area. Placeholder screens ship in a later slice.
        </div>
      </footer>
    </div>
  );
}
