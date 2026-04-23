// Client-side 404 fallback for SPA routes that don't match. This only
// fires for paths the Worker let fall through to Workers Assets, so
// anything the router doesn't recognise ends up here rather than the
// browser's default blank screen.
import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[1200px] flex-col items-start justify-center gap-4 bg-cf-bg-100 px-6 font-sans text-cf-text">
      <p className="font-mono text-sm text-cf-text-subtle">404</p>
      <h1 className="text-4xl font-medium tracking-tight">
        This page doesn't exist yet.
      </h1>
      <p className="max-w-[56ch] text-cf-text-muted">
        The rated.watch SPA is still growing. If you followed a link here
        from an earlier slice, the target probably hasn't shipped yet.
      </p>
      <Link
        to="/app/dashboard"
        className="mt-4 inline-flex items-center gap-2 rounded-full bg-cf-orange px-6 py-3 text-sm font-medium text-[#fffbf5] transition-colors hover:bg-cf-orange-hover"
      >
        Back to dashboard →
      </Link>
    </main>
  );
}
