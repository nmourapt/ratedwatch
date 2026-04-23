// Public HTML leaderboard page. SSR via hono/jsx — zero client JS.
//
// Reads ?verified=1 to flip verified_only at the domain layer. Renders
// a table-style list where each row links off to (slice 14/15) pages
// that haven't shipped yet; those anchors are harmless — they become
// real destinations as those slices land.
//
// The list is short + mostly-numeric so a <table> is the semantic fit
// (screen readers + copy-paste into a spreadsheet both "just work").

import { Footer } from "../components/footer";
import { Header } from "../components/header";
import { Layout } from "../components/layout";
import type { RankedWatch } from "@/domain/leaderboard-query";
import { formatDriftRate, formatWatchLabel } from "./format";

export interface LeaderboardPageProps {
  watches: RankedWatch[];
  verifiedOnly: boolean;
}

const TITLE = "Leaderboard — rated.watch";
const DESCRIPTION =
  "Global accuracy leaderboard. Watches ranked by absolute drift rate, grouped by movement caliber.";

export const LeaderboardPage = ({ watches, verifiedOnly }: LeaderboardPageProps) => (
  <Layout title={TITLE} description={DESCRIPTION} pathname="/leaderboard">
    <LeaderboardStyles />
    <Header />
    <main>
      <section class="cf-container cf-hero" aria-labelledby="lb-title">
        <h1 id="lb-title">Global leaderboard</h1>
        <p>
          Ranked by absolute drift rate since each watch's most recent baseline. Lower is
          better — a drift of 0 s/d means the watch is keeping time perfectly.
        </p>
        <nav class="cf-lb-filters" aria-label="Leaderboard filters">
          <a href="/leaderboard" class={verifiedOnly ? "" : "cf-lb-filter--active"}>
            All watches
          </a>
          <a
            href="/leaderboard?verified=1"
            class={verifiedOnly ? "cf-lb-filter--active" : ""}
          >
            Verified only
          </a>
        </nav>
      </section>

      <section class="cf-container cf-section" aria-label="Leaderboard rankings">
        {watches.length === 0 ? <EmptyState verifiedOnly={verifiedOnly} /> : null}
        {watches.length > 0 ? <LeaderboardTable watches={watches} /> : null}
      </section>

      <section class="cf-container cf-lb-footnote">
        <p>
          Watches need at least <strong>7 days</strong> of readings and at least{" "}
          <strong>3 readings</strong> since their current baseline to appear on the
          leaderboard. The <span class="cf-lb-verified-dot" aria-hidden="true"></span>{" "}
          verified badge means 25 % or more of the readings in this session were captured
          through the in-app camera flow (spoof-resistant).
        </p>
      </section>
    </main>
    <Footer />
  </Layout>
);

function EmptyState({ verifiedOnly }: { verifiedOnly: boolean }) {
  return (
    <div class="cf-card">
      <div class="cf-brackets" aria-hidden="true">
        <span />
      </div>
      <h2 class="cf-card__title">
        {verifiedOnly ? "No verified watches yet" : "No eligible watches yet"}
      </h2>
      <div class="cf-card__body">
        <p>
          {verifiedOnly
            ? "Nobody's crossed the 25 % verified-reading threshold in their current session. Start logging verified readings through the app and you could be first."
            : "Nobody has logged enough readings yet. Create an account and be the first to appear here."}
        </p>
      </div>
    </div>
  );
}

function LeaderboardTable({ watches }: { watches: RankedWatch[] }) {
  return (
    <table class="cf-lb-table">
      <thead>
        <tr>
          <th scope="col" class="cf-lb-col-rank">
            #
          </th>
          <th scope="col">Watch</th>
          <th scope="col">Movement</th>
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
            <td>
              <a href={`/m/${w.movement_id}`}>{w.movement_canonical_name}</a>
            </td>
            <td>
              <a href={`/u/${w.owner_username}`}>@{w.owner_username}</a>
            </td>
            <td class="cf-lb-col-num">
              {formatDriftRate(w.session_stats.avg_drift_rate_spd)}
            </td>
            <td>
              {w.session_stats.verified_badge ? (
                <span class="cf-lb-badge" title="25 %+ verified readings this session">
                  Verified
                </span>
              ) : (
                <span class="cf-lb-badge cf-lb-badge--muted">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Scoped stylesheet for the leaderboard page. Keeps the table styling
// out of the shared Layout stylesheet so /leaderboard doesn't pay the
// cost on every public page. Inlined because we're already inlining
// the design-token sheet — one more small <style> tag is cheaper than
// a second HTTP round-trip for a stylesheet request.
function LeaderboardStyles() {
  const css = `
.cf-lb-filters {
  display: flex;
  gap: 16px;
  margin-top: 16px;
  font-size: 0.875rem;
}
.cf-lb-filters a {
  color: var(--cf-text-muted);
  padding: 6px 12px;
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-full);
}
.cf-lb-filters a:hover { color: var(--cf-text); background: var(--cf-bg-300); }
.cf-lb-filter--active {
  color: var(--cf-text) !important;
  border-color: var(--cf-orange) !important;
  background: var(--cf-bg-200);
}

.cf-lb-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.95rem;
}
.cf-lb-table thead th {
  text-align: left;
  padding: 12px;
  border-bottom: 1px solid var(--cf-border);
  font-weight: 500;
  color: var(--cf-text-muted);
  font-size: 0.85rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.cf-lb-table tbody td {
  padding: 12px;
  border-bottom: 1px solid var(--cf-border-light);
  vertical-align: middle;
}
.cf-lb-col-rank {
  width: 3rem;
  font-family: var(--cf-font-mono);
  color: var(--cf-text-muted);
}
.cf-lb-col-num {
  font-family: var(--cf-font-mono);
  text-align: right;
  white-space: nowrap;
}

.cf-lb-badge {
  display: inline-flex;
  padding: 3px 10px;
  border-radius: var(--cf-radius-full);
  background: var(--cf-orange);
  color: #FFFBF5;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.02em;
}
.cf-lb-badge--muted {
  background: transparent;
  color: var(--cf-text-subtle);
}

.cf-lb-verified-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--cf-orange);
  vertical-align: middle;
  margin: 0 4px;
}

.cf-lb-footnote {
  padding: 24px 24px 48px;
  color: var(--cf-text-muted);
  font-size: 0.9rem;
}
.cf-lb-footnote p { max-width: 70ch; margin: 0; }
`;
  return <style>{css}</style>;
}
