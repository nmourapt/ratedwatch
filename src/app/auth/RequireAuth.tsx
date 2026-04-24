// Route-level guard. Wraps every authed /app/* route and redirects to
// /app/login when `GET /api/v1/me` returns 401. Renders a minimal
// loading screen during the initial session probe so we don't flash
// the protected content to anonymous viewers.

import { Navigate, Outlet } from "react-router";
import { useSession } from "./useSession";

export function RequireAuth() {
  const { status } = useSession();

  if (status === "loading") {
    return (
      <section className="mx-auto flex min-h-[60vh] max-w-[1200px] items-center justify-center">
        <p className="font-mono text-sm text-ink-subtle">Checking session…</p>
      </section>
    );
  }

  if (status === "anonymous") {
    return <Navigate to="/app/login" replace />;
  }

  return <Outlet />;
}
