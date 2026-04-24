// Per-movement leaderboard page. Public SSR via hono/jsx — zero
// client JS. Reuses <LeaderboardTable> from the global leaderboard
// page so the table styling, badge rendering, and empty-state card
// all stay consistent across the two surfaces.
//
// The commercial CTA lives here: a prominent "Shop on Chrono24"
// button built via the chrono24-link domain module. Every Chrono24
// URL in the app flows through that module, so adding an affiliate
// ID later is a single-file change.

import { Footer } from "../components/footer";
import { Header } from "../components/header";
import { Layout } from "../components/layout";
import type { Movement } from "@/domain/movements/taxonomy";
import type { RankedWatch } from "@/domain/leaderboard-query";
import {
  LeaderboardStyles,
  LeaderboardTable,
  VerifiedFilterToggle,
} from "../leaderboard/table";

export interface MovementPageProps {
  movement: Movement;
  watches: RankedWatch[];
  verifiedOnly: boolean;
}

export const MovementPage = ({ movement, watches, verifiedOnly }: MovementPageProps) => {
  const title = `Most accurate ${movement.canonical_name} watches — rated.watch`;
  const description = `Drift rate leaderboard for the ${movement.canonical_name} ${movement.type} movement.`;
  // Route the CTA through /out/chrono24/:movementId so the Worker can
  // count clicks (logEvent("chrono24_click", …)) before the 302 to
  // Chrono24 itself. See src/server/routes/out.ts.
  const chrono24Url = `/out/chrono24/${movement.id}`;

  return (
    <Layout title={title} description={description} pathname={`/m/${movement.id}`}>
      <LeaderboardStyles />
      <MovementPageStyles />
      <Header />
      <main>
        <section class="cf-container cf-hero" aria-labelledby="mv-title">
          <p class="cf-mv-crumbs">
            <a href="/leaderboard">← Back to global leaderboard</a>
          </p>
          <h1 id="mv-title">{movement.canonical_name}</h1>
          <p class="cf-mv-meta">
            {movement.manufacturer} <span aria-hidden="true">·</span> {movement.caliber}{" "}
            <span aria-hidden="true">·</span>{" "}
            <span class="cf-mv-type">{movement.type}</span>
          </p>
          <div class="cf-mv-cta">
            <a
              class="cf-btn cf-btn--primary cf-mv-chrono24"
              href={chrono24Url}
              target="_blank"
              rel="sponsored nofollow noopener noreferrer"
            >
              Shop on Chrono24 →
            </a>
          </div>
          <VerifiedFilterToggle
            basePath={`/m/${movement.id}`}
            verifiedOnly={verifiedOnly}
          />
        </section>

        <section class="cf-container cf-section" aria-label="Movement rankings">
          <LeaderboardTable
            watches={watches}
            showMovementColumn={false}
            emptyStateTitle={
              verifiedOnly
                ? "No verified watches on this movement yet"
                : "No ranked watches on this movement yet"
            }
            emptyStateBody={
              verifiedOnly
                ? `Nobody running a ${movement.canonical_name} has crossed the 25 % verified-reading threshold. Switch to "All watches" to see everyone ranked, or log verified readings yourself to be first.`
                : `Nobody with a ${movement.canonical_name} has logged enough readings to appear here yet. Create an account, add your watch, and start logging.`
            }
          />
        </section>

        <section class="cf-container cf-lb-footnote">
          <p>
            Watches need at least <strong>7 days</strong> of readings and at least{" "}
            <strong>3 readings</strong> since their current baseline to appear. The{" "}
            <span class="cf-lb-verified-dot" aria-hidden="true"></span> verified badge
            means 25 % or more of the readings in this session were captured through the
            in-app camera flow (spoof-resistant).
          </p>
        </section>
      </main>
      <Footer />
    </Layout>
  );
};

// Movement-page-specific chrome: the caliber meta line, back-link,
// and CTA spacing. The shared leaderboard stylesheet already owns
// the table + badge styling.
function MovementPageStyles() {
  const css = `
.cf-mv-crumbs {
  margin: 0 0 12px;
  font-size: 0.875rem;
}
.cf-mv-crumbs a { color: var(--ink-muted); }
.cf-mv-crumbs a:hover { color: var(--ink); }

.cf-mv-meta {
  color: var(--ink-muted);
  font-family: var(--cf-font-mono);
  font-size: 0.95rem;
  margin: 0 0 24px;
  letter-spacing: -0.01em;
}
.cf-mv-type { text-transform: capitalize; }

.cf-mv-cta { margin-top: 8px; }
.cf-mv-chrono24 {
  padding: 14px 28px;
  font-size: 1.05rem;
  letter-spacing: -0.01em;
}
`;
  return <style>{css}</style>;
}

// ---- 404 page -----------------------------------------------------

const NOT_FOUND_TITLE = "Movement not found — rated.watch";
const NOT_FOUND_DESCRIPTION =
  "The movement you're looking for doesn't exist or isn't published yet.";

export const MovementNotFoundPage = () => (
  <Layout
    title={NOT_FOUND_TITLE}
    description={NOT_FOUND_DESCRIPTION}
    pathname="/m/unknown"
  >
    <Header />
    <main>
      <section class="cf-container cf-hero">
        <h1>Movement not found</h1>
        <p>{NOT_FOUND_DESCRIPTION}</p>
        <p>
          <a class="cf-btn cf-btn--ghost" href="/leaderboard">
            ← Back to global leaderboard
          </a>
        </p>
      </section>
    </main>
    <Footer />
  </Layout>
);
