// Server-rendered public home page. Zero client JS (asserted by the
// "no <script> tag" integration test). The shared <Layout> owns the
// design-system tokens and OG meta; this file only owns copy and the
// top-verified-watches hero section that sits below the main CTA.
//
// Slice #13 extended the page from pure copy into a data-backed hero:
// the Worker fetches the current top-5 verified watches via
// queryLeaderboard and passes them in as a prop so /‎ stays a single
// HTML response with no client fetching.
import type { RankedWatch } from "@/domain/leaderboard-query";
import { Button } from "./components/button";
import { Card } from "./components/card";
import { Footer } from "./components/footer";
import { Header } from "./components/header";
import { Layout } from "./components/layout";
import { formatDriftRate, formatWatchLabel } from "./leaderboard/format";

const TITLE = "rated.watch — competitive accuracy tracking for watch enthusiasts";
const DESCRIPTION =
  "Competitive accuracy tracking for watch enthusiasts. Verified deviation, drift-rate leaderboards, grouped by movement.";

export interface LandingPageProps {
  /** Top-5 verified watches from the global leaderboard. May be empty
   *  during the cold-start phase when nobody has crossed the verified
   *  threshold yet. */
  topVerified?: RankedWatch[];
}

export const LandingPage = ({ topVerified = [] }: LandingPageProps) => (
  <Layout title={TITLE} description={DESCRIPTION} pathname="/">
    <Header />
    <main>
      <section class="cf-container cf-hero" aria-labelledby="hero-title">
        <h1 id="hero-title">Competitive accuracy tracking for watch enthusiasts.</h1>
        <p>
          Log verified readings, watch your drift rate settle, and climb the leaderboards
          grouped by movement caliber. Spoof-resistant, public, and mechanical-first.
        </p>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          {/* Warm-stone is the DESIGN.md signature CTA — use it only on
              the most prominent action per page. Landing hero is the
              canonical spot. Secondary / tertiary CTAs stay ghost+primary. */}
          <Button as="a" href="/leaderboard" variant="warm">
            Browse leaderboards →
          </Button>
          <Button as="a" href="/app/register" variant="ghost">
            Create an account
          </Button>
        </div>
      </section>

      <section class="cf-container cf-section" aria-labelledby="top-verified-title">
        <h2
          id="top-verified-title"
          style="margin:0 0 24px;font-family:var(--font-display);font-size:1.5rem;font-weight:300;letter-spacing:-0.02em;color:var(--color-ink)"
        >
          Top verified watches
        </h2>
        {topVerified.length === 0 ? (
          <Card title="Be the first to log a verified reading!">
            Nobody's crossed the 25 % verified-reading threshold yet. Sign up, log your
            first baseline through the app camera flow, and you could be the watch
            everyone else is chasing.
          </Card>
        ) : (
          <div class="cf-grid-2">
            {topVerified.map((w) => (
              <Card
                title={formatWatchLabel({
                  name: w.watch_name,
                  brand: w.watch_brand,
                  model: w.watch_model,
                })}
              >
                <p style="margin:0 0 8px">
                  <a href={`/m/${w.movement_id}`}>{w.movement_canonical_name}</a>
                  <span style="color:var(--color-ink-subtle)"> · </span>
                  <a href={`/u/${w.owner_username}`}>@{w.owner_username}</a>
                </p>
                <p style="margin:0;font-family:var(--font-mono)">
                  Drift{" "}
                  <strong>{formatDriftRate(w.session_stats.avg_drift_rate_spd)}</strong>{" "}
                  <span style="color:var(--color-ink-subtle)">
                    · rank #{String(w.rank)}
                  </span>
                </p>
              </Card>
            ))}
          </div>
        )}
      </section>
    </main>
    <Footer />
  </Layout>
);
