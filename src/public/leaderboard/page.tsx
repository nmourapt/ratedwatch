// Public HTML leaderboard page. SSR via hono/jsx — zero client JS.
//
// Reads ?verified=1 to flip verified_only at the domain layer. Renders
// the shared <LeaderboardTable> component, which also exports the
// stylesheet so the per-movement page (slice #14) picks up the same
// table styling for free.

import { Footer } from "../components/footer";
import { Header } from "../components/header";
import { Layout } from "../components/layout";
import type { RankedWatch } from "@/domain/leaderboard-query";
import { LeaderboardStyles, LeaderboardTable } from "./table";

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
        <LeaderboardTable
          watches={watches}
          emptyStateTitle={
            verifiedOnly ? "No verified watches yet" : "No eligible watches yet"
          }
          emptyStateBody={
            verifiedOnly
              ? "Nobody's crossed the 25 % verified-reading threshold in their current session. Start logging verified readings through the app and you could be first."
              : "Nobody has logged enough readings yet. Create an account and be the first to appear here."
          }
        />
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
