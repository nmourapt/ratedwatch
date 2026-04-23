// Authed SPA chrome. Renders the shared Header/Footer equivalent for the
// app surface and an <Outlet /> for the current placeholder page. Slice 3
// only wires the design language — real auth gating, nav links, and
// screen content come in later slices.
import { Link, Outlet } from "react-router";

export function App() {
  return (
    <div className="min-h-screen flex flex-col bg-cf-bg-100 text-cf-text font-sans">
      <header className="border-b border-cf-border bg-cf-bg-100">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4 px-6 py-4">
          <Link
            to="/app"
            className="font-mono text-base font-medium tracking-tight text-cf-text hover:text-cf-text"
            aria-label="rated.watch app home"
          >
            rated<span className="text-cf-orange">.</span>watch
          </Link>
          <nav
            aria-label="App primary"
            className="flex gap-6 text-sm text-cf-text-muted"
          >
            <Link to="/app/dashboard" className="hover:text-cf-text">
              Dashboard
            </Link>
            <Link to="/app/settings" className="hover:text-cf-text">
              Settings
            </Link>
            <a
              href="/"
              className="hover:text-cf-text"
              aria-label="Back to public site"
            >
              ← Site
            </a>
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <div className="mx-auto max-w-[1200px] px-6 py-12">
          <Outlet />
        </div>
      </main>
      <footer className="border-t border-cf-border py-8 text-sm text-cf-text-subtle">
        <div className="mx-auto max-w-[1200px] px-6">
          rated.watch — authed area. Placeholder screens ship in a later
          slice.
        </div>
      </footer>
    </div>
  );
}
