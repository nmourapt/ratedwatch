// Authed dashboard. Reads the session via `useSession` (already
// resolved by the RequireAuth wrapper that guards this route), so we
// can render the username + sign-out affordance immediately without
// a second network call.

import { useNavigate } from "react-router";
import { logout } from "../auth/api";
import { useSession } from "../auth/useSession";

export function DashboardPage() {
  const navigate = useNavigate();
  const { user } = useSession();

  async function onLogout() {
    await logout();
    navigate("/app/login", { replace: true });
  }

  return (
    <section>
      <h1 className="mb-4 text-4xl font-medium tracking-tight text-cf-text">Dashboard</h1>
      {user ? (
        <p className="mb-6 text-cf-text">
          Logged in as <span className="font-mono text-cf-orange">@{user.username}</span>.
        </p>
      ) : (
        <p className="mb-6 text-cf-text-muted">Loading profile…</p>
      )}
      <p className="mb-8 max-w-[56ch] text-cf-text-muted">
        Your watches, current session drift, and quick-log shortcuts will appear here as
        later slices ship.
      </p>
      <button
        type="button"
        onClick={onLogout}
        className="inline-flex items-center justify-center rounded-full border border-cf-border bg-transparent px-5 py-2.5 text-sm font-medium text-cf-text transition-colors hover:border-cf-orange hover:text-cf-orange"
      >
        Sign out
      </button>
    </section>
  );
}
