// Authed dashboard. Lists the caller's watches as link cards plus an
// "Add watch" affordance. The dashboard is the authed SPA's home; a
// user with no watches sees a gentle empty state that routes them
// straight into the add flow.
//
// Reading-anchored stats (current drift, session length) ship in a
// later slice — the card currently reserves that row with a muted
// placeholder so the layout is stable when it lights up.

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { logout } from "../auth/api";
import { useSession } from "../auth/useSession";
import { listWatches, type Watch } from "../watches/api";

type WatchesState =
  | { kind: "loading" }
  | { kind: "loaded"; watches: Watch[] }
  | { kind: "error"; message: string };

export function DashboardPage() {
  const navigate = useNavigate();
  const { user } = useSession();
  const [state, setState] = useState<WatchesState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await listWatches();
      if (cancelled) return;
      if (result.ok) {
        setState({ kind: "loaded", watches: result.watches });
      } else {
        setState({ kind: "error", message: result.error.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onLogout() {
    await logout();
    navigate("/app/login", { replace: true });
  }

  return (
    <section>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="mb-2 text-4xl font-medium tracking-tight text-cf-text">
            Dashboard
          </h1>
          {user ? (
            <p className="text-cf-text">
              Logged in as{" "}
              <span className="font-mono text-cf-orange">@{user.username}</span>.
            </p>
          ) : (
            <p className="text-cf-text-muted">Loading profile…</p>
          )}
        </div>
        <Link
          to="/app/watches/new"
          className="inline-flex items-center justify-center rounded-full bg-cf-orange px-5 py-2.5 text-sm font-medium text-[#fffbf5] transition-colors hover:bg-cf-orange-hover"
        >
          Add watch
        </Link>
      </div>

      <div className="mb-10">
        {state.kind === "loading" ? (
          <p className="font-mono text-sm text-cf-text-subtle">Loading watches…</p>
        ) : state.kind === "error" ? (
          <p
            role="alert"
            className="rounded-md border border-cf-orange/40 bg-cf-orange/10 px-3 py-2 text-sm text-cf-text"
          >
            {state.message}
          </p>
        ) : state.watches.length === 0 ? (
          <div className="rounded-lg border border-dashed border-cf-border bg-cf-bg-200 px-6 py-10 text-center">
            <p className="mb-3 text-cf-text">No watches yet.</p>
            <p className="mb-4 text-sm text-cf-text-muted">
              Add your first watch to start tracking accuracy against a reference.
            </p>
            <Link
              to="/app/watches/new"
              className="inline-flex items-center justify-center rounded-full bg-cf-orange px-5 py-2.5 text-sm font-medium text-[#fffbf5] transition-colors hover:bg-cf-orange-hover"
            >
              Add your first watch
            </Link>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {state.watches.map((watch) => (
              <li key={watch.id}>
                <Link
                  to={`/app/watches/${watch.id}`}
                  className="flex h-full flex-col gap-2 rounded-lg border border-cf-border bg-cf-bg-100 p-4 transition-colors hover:border-cf-orange"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-lg font-medium text-cf-text">{watch.name}</h2>
                    {watch.is_public ? null : (
                      <span className="rounded-full border border-cf-orange/40 bg-cf-orange/10 px-2 py-0.5 text-xs font-medium text-cf-orange">
                        Private
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-cf-text-muted">
                    {watch.brand || watch.model
                      ? [watch.brand, watch.model].filter(Boolean).join(" ")
                      : "No brand/model"}
                  </p>
                  <p className="text-xs text-cf-text-muted">
                    {watch.movement_canonical_name ??
                      (watch.custom_movement_name
                        ? `Custom: ${watch.custom_movement_name}`
                        : "No movement")}
                  </p>
                  <p className="mt-auto text-xs text-cf-text-subtle">No readings yet</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

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
