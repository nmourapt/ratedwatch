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
import { listWatches, type WatchWithSession } from "../watches/api";
import { VerifiedProgressRing } from "../watches/VerifiedProgressRing";

type WatchesState =
  | { kind: "loading" }
  | { kind: "loaded"; watches: WatchWithSession[] }
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
          <h1 className="mb-2 font-display text-4xl font-light tracking-tight text-ink">
            Dashboard
          </h1>
          {user ? (
            <p className="text-ink">
              Logged in as <span className="font-mono text-accent">@{user.username}</span>
              .
            </p>
          ) : (
            <p className="text-ink-muted">Loading profile…</p>
          )}
        </div>
        <Link
          to="/app/watches/new"
          className="inline-flex min-h-[44px] items-center justify-center rounded-pill bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
        >
          Add watch
        </Link>
      </div>

      <div className="mb-10">
        {state.kind === "loading" ? (
          <p className="font-mono text-sm text-ink-subtle">Loading watches…</p>
        ) : state.kind === "error" ? (
          <p
            role="alert"
            className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink"
          >
            {state.message}
          </p>
        ) : state.watches.length === 0 ? (
          <div className="rounded-card border border-dashed border-line bg-surface-inset px-6 py-12 text-center">
            <p className="mb-3 text-ink">No watches yet.</p>
            <p className="mb-4 text-sm text-ink-muted">
              Add your first watch to start tracking accuracy against a reference.
            </p>
            <Link
              to="/app/watches/new"
              className="inline-flex min-h-[44px] items-center justify-center rounded-pill bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
            >
              Add your first watch
            </Link>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {state.watches.map((watch) => {
              const stats = watch.session_stats;
              const verifiedCount = Math.round(
                stats.reading_count * stats.verified_ratio,
              );
              return (
                <li key={watch.id}>
                  <Link
                    to={`/app/watches/${watch.id}`}
                    className="flex h-full flex-col gap-2 rounded-card border border-line bg-canvas p-6 shadow-card transition-colors hover:border-accent"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="text-lg font-medium text-ink">{watch.name}</h2>
                      {watch.is_public ? null : (
                        <span className="inline-flex items-center gap-1 rounded-pill border border-accent/25 bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent">
                          Private
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-ink-muted">
                      {watch.brand || watch.model
                        ? [watch.brand, watch.model].filter(Boolean).join(" ")
                        : "No brand/model"}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {watch.movement_canonical_name ??
                        (watch.custom_movement_name
                          ? `Custom: ${watch.custom_movement_name}`
                          : "No movement")}
                    </p>
                    <div className="mt-auto pt-2">
                      <VerifiedProgressRing
                        verifiedCount={verifiedCount}
                        totalCount={stats.reading_count}
                        size={48}
                      />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <button
        type="button"
        onClick={onLogout}
        className="inline-flex min-h-[44px] items-center justify-center rounded-pill border border-line bg-canvas px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-accent hover:text-accent"
      >
        Sign out
      </button>
    </section>
  );
}
