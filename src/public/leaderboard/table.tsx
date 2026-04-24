// Shared leaderboard table component. Rendered by the global
// /leaderboard page and the per-movement /m/:id page (slice #14).
//
// Kept as a pure component that takes a ranked list and emits the
// table markup + the small empty-state block. Page-level chrome
// (hero, filter nav, footnote, Chrono24 CTA) is NOT this component's
// concern — each page wraps the table with its own context.
//
// The styles both pages need are colocated here too, exported as
// <LeaderboardStyles /> so a page mounting the table picks up the
// CSS automatically without duplicating the stylesheet.

import type { RankedWatch } from "@/domain/leaderboard-query";
import { formatDriftRate, formatWatchLabel } from "./format";

/**
 * Toggle UI for the "All watches / Verified only" filter.
 *
 * Rendered as a pair of GET-link buttons — zero client JS, the server
 * computes which one is active from the request (query param + cookie
 * state) and feeds `verifiedOnly` in. Clicking emits a GET to the
 * same path with the flipped `?verified=…` param so the handler can
 * also set/clear the `rw_verified_filter` cookie.
 *
 * Used by both /leaderboard and /m/:id so the copy stays in sync.
 */
export interface VerifiedFilterToggleProps {
  /** Base path to link to. The component adds the `?verified=…` param. */
  basePath: string;
  /** Current filter state (derived server-side from query param + cookie). */
  verifiedOnly: boolean;
}

export const VerifiedFilterToggle = ({
  basePath,
  verifiedOnly,
}: VerifiedFilterToggleProps) => (
  <nav class="cf-lb-filters" aria-label="Leaderboard filters">
    <a
      href={`${basePath}?verified=0`}
      class={verifiedOnly ? "" : "cf-lb-filter--active"}
      aria-pressed={verifiedOnly ? "false" : "true"}
    >
      All watches
    </a>
    <a
      href={`${basePath}?verified=1`}
      class={verifiedOnly ? "cf-lb-filter--active" : ""}
      aria-pressed={verifiedOnly ? "true" : "false"}
    >
      <span class="cf-lb-filter__check" aria-hidden="true">
        ✓
      </span>{" "}
      Verified only
    </a>
  </nav>
);

export interface LeaderboardTableProps {
  watches: RankedWatch[];
  /**
   * Copy shown when `watches` is empty. Different pages have different
   * reasons for an empty list (no verified watches yet, no watches on
   * this movement yet), so the caller supplies the copy.
   */
  emptyStateTitle: string;
  emptyStateBody: string;
  /**
   * Whether to show the Movement column. The global leaderboard needs
   * it (watches come from many movements); the per-movement page
   * doesn't (everything on the page is the same movement by
   * definition).
   */
  showMovementColumn?: boolean;
}

export const LeaderboardTable = ({
  watches,
  emptyStateTitle,
  emptyStateBody,
  showMovementColumn = true,
}: LeaderboardTableProps) => {
  if (watches.length === 0) {
    return (
      <div class="cf-card">
        <div class="cf-brackets" aria-hidden="true">
          <span />
        </div>
        <h2 class="cf-card__title">{emptyStateTitle}</h2>
        <div class="cf-card__body">
          <p>{emptyStateBody}</p>
        </div>
      </div>
    );
  }

  return (
    <table class="cf-lb-table">
      <thead>
        <tr>
          <th scope="col" class="cf-lb-col-rank">
            #
          </th>
          <th scope="col">Watch</th>
          {showMovementColumn ? <th scope="col">Movement</th> : null}
          <th scope="col">Owner</th>
          <th scope="col" class="cf-lb-col-num">
            Drift
          </th>
          <th scope="col">Badge</th>
        </tr>
      </thead>
      <tbody>
        {watches.map((w) => (
          <tr>
            <td class="cf-lb-col-rank">{String(w.rank)}</td>
            <td>
              <a href={`/w/${w.watch_id}`}>
                {formatWatchLabel({
                  name: w.watch_name,
                  brand: w.watch_brand,
                  model: w.watch_model,
                })}
              </a>
            </td>
            {showMovementColumn ? (
              <td>
                <a href={`/m/${w.movement_id}`}>{w.movement_canonical_name}</a>
              </td>
            ) : null}
            <td>
              <a href={`/u/${w.owner_username}`}>@{w.owner_username}</a>
            </td>
            <td class="cf-lb-col-num">
              {formatDriftRate(w.session_stats.avg_drift_rate_spd)}
            </td>
            <td>
              {w.session_stats.verified_badge ? (
                <span
                  class="cf-lb-badge"
                  title="25 %+ verified readings this session"
                  data-verified-badge="true"
                >
                  <span class="cf-lb-badge__check" aria-hidden="true">
                    ✓
                  </span>{" "}
                  Verified
                </span>
              ) : (
                <span
                  class="cf-lb-badge cf-lb-badge--muted"
                  title="Fewer than 25 % of readings in this session are verified"
                  aria-label="Unverified"
                >
                  —
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/**
 * Scoped stylesheet for the leaderboard table + surrounding page
 * chrome (filter nav, badge, footnote). Inlined because we already
 * inline the design-tokens sheet — one extra <style> tag beats a
 * second round-trip.
 */
export function LeaderboardStyles() {
  const css = `
.cf-lb-filters {
  display: flex;
  gap: 12px;
  margin-top: 16px;
  font-size: 0.875rem;
  flex-wrap: wrap;
}
/* Filter toggle — pill segments (DESIGN.md section 4). Subtle inset
 * edge at rest, promoted to a shadow-card tier when active so the
 * selection reads at a glance without a loud accent box. */
.cf-lb-filters a {
  color: var(--color-ink-muted);
  padding: 8px 16px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-inset-edge);
  transition: background-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
  font-weight: 500;
  letter-spacing: 0.01em;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.cf-lb-filters a:hover {
  color: var(--color-ink);
  background: var(--color-surface-inset);
}
.cf-lb-filter--active {
  color: var(--color-ink) !important;
  border-color: var(--color-ink) !important;
  background: var(--color-canvas);
  box-shadow: var(--shadow-card);
}
.cf-lb-filter__check {
  color: var(--color-ink);
  font-weight: 700;
}

/* Table is wrapped in a card-like chrome — layered shadow +
 * rounded corners lift it off the canvas the same way the SPA
 * shadow-card utility does. The thead border is the full --color-line
 * (a deliberate step stronger than row dividers so the header reads
 * as a different zone), while the row dividers use the ~5 % line token
 * — airy and "felt more than seen", per DESIGN.md section 6. */
.cf-lb-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.95rem;
  background: var(--color-canvas);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}
.cf-lb-table thead th {
  text-align: left;
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-line);
  background: var(--color-canvas);
  font-weight: 500;
  color: var(--color-ink-muted);
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.cf-lb-table tbody td {
  padding: 14px 16px;
  border-top: 1px solid var(--color-line-subtle);
  vertical-align: middle;
}
.cf-lb-table tbody tr:first-child td {
  border-top: 0;
}
.cf-lb-table tbody tr {
  transition: background-color 0.15s ease;
}
.cf-lb-table tbody tr:hover {
  background: var(--color-surface-inset);
}
.cf-lb-col-rank {
  width: 3rem;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--color-ink-muted);
}
.cf-lb-col-num {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

/* Verified badge — DESIGN.md section 4 small-badge shape. Soft-tone
 * pill using color-mix on the accent hue (no new colour introduced;
 * palette v4 is intentionally achromatic). Border + fill at low
 * opacity reads "accent-aligned" without competing with the primary
 * black CTA. */
.cf-lb-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  color: var(--color-accent);
  border: 1px solid color-mix(in srgb, var(--color-accent) 25%, transparent);
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  line-height: 1.3;
}
.cf-lb-badge--muted {
  background: transparent;
  border-color: transparent;
  color: var(--color-ink-subtle);
}
.cf-lb-badge__check {
  font-weight: 700;
  line-height: 1;
}

.cf-lb-verified-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-accent);
  vertical-align: middle;
  margin: 0 4px;
}

.cf-lb-footnote {
  padding: 24px 24px 48px;
  color: var(--color-ink-muted);
  font-size: 0.9rem;
}
.cf-lb-footnote p { max-width: 70ch; margin: 0; }
`;
  return <style>{css}</style>;
}
