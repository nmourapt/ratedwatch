// Server-rendered public home page. Zero client JS (asserted by the
// "no <script> tag" integration test). The shared <Layout> owns the
// design-system tokens and OG meta; this file only owns copy.
import { Layout } from "./components/layout";
import { Header } from "./components/header";
import { Footer } from "./components/footer";
import { Button } from "./components/button";
import { Card } from "./components/card";

const TITLE = "rated.watch — competitive accuracy tracking for watch enthusiasts";
const DESCRIPTION =
  "Competitive accuracy tracking for watch enthusiasts. Verified deviation, drift-rate leaderboards, grouped by movement.";

export const LandingPage = () => (
  <Layout title={TITLE} description={DESCRIPTION} pathname="/">
    <Header />
    <main>
      <section class="cf-container cf-hero" aria-labelledby="hero-title">
        <h1 id="hero-title">
          Competitive accuracy tracking for watch enthusiasts.
        </h1>
        <p>
          Log verified readings, watch your drift rate settle, and climb the
          leaderboards grouped by movement caliber. Spoof-resistant, public,
          and mechanical-first.
        </p>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <Button as="a" href="/leaderboard" variant="primary">
            Browse leaderboards →
          </Button>
          <Button as="a" href="/app/register" variant="ghost">
            Create an account
          </Button>
        </div>
      </section>

      <section class="cf-container cf-section" aria-labelledby="next-title">
        <h2 id="next-title" style="margin:0 0 24px;font-size:1.25rem;font-weight:500;letter-spacing:-0.02em;color:var(--cf-text-muted)">
          Coming soon
        </h2>
        <div class="cf-grid-2">
          <Card title="Leaderboards by movement">
            Watches compete within their own caliber — a Calibre 3135 is judged
            against other 3135s, not a quartz HAQ. Fair, apples-to-apples
            rankings by drift rate over the last session.
          </Card>
          <Card title="Verified readings only">
            In-app camera captures are timestamped by the server at receipt.
            No trusting client clocks. Watches hit a verified badge when 25 %
            of their current session is camera-sourced.
          </Card>
        </div>
      </section>
    </main>
    <Footer />
  </Layout>
);
