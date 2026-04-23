// Public per-watch page. SSR via hono/jsx — zero client JS.
//
// Route: GET /w/:watchId. 404s for unknown AND private watches (see
// loadPublicWatch — we deliberately collapse both states to one
// response so the public surface doesn't leak the existence of
// private rows). The authed SPA at /app/watches/:id is where owners
// manage their own private watches.
//
// Rendering order:
//   1. Hero — brand + model + watch name.
//   2. Meta — owner link, movement link (when approved), photo.
//   3. Stats panel — session_days, reading_count, verified_ratio, drift.
//   4. SVG chart.
//   5. Reading history table (most-recent first).
//   6. Chrono24 CTA.

import { buildChrono24UrlForWatch } from "@/domain/chrono24-link";
import type { Reading, SessionStats } from "@/domain/drift-calc";
import { Footer } from "../components/footer";
import { Header } from "../components/header";
import { Layout } from "../components/layout";
import { formatDriftRate, formatWatchLabel } from "../leaderboard/format";
import { DeviationChart } from "./chart";
import type { PublicWatch, PublicWatchPageData } from "./load";

export interface WatchPageProps {
  data: PublicWatchPageData;
}

export const WatchPage = ({ data }: WatchPageProps) => {
  const { watch, readings, session_stats } = data;
  const label = formatWatchLabel({
    name: watch.name,
    brand: watch.brand,
    model: watch.model,
  });
  // Prefer the click-tracked movement redirect so we count clicks in
  // Analytics Engine. Fall back to a direct Chrono24 search on
  // brand+model when the watch has no approved movement attached —
  // the tracked redirect needs a movement id.
  const chrono24Href = watch.movement_id
    ? `/out/chrono24/${watch.movement_id}`
    : buildChrono24UrlForWatch({
        brand: watch.brand,
        model: watch.model,
        name: watch.name,
      });
  const title = `${label} — rated.watch`;
  const description = `${label} owned by @${watch.owner_username}. Deviation history + drift rate on rated.watch.`;
  return (
    <Layout title={title} description={description} pathname={`/w/${watch.watch_id}`}>
      <WatchPageStyles />
      <Header />
      <main>
        <section class="cf-container cf-hero" aria-labelledby="w-title">
          <h1 id="w-title">{watch.name}</h1>
          <p class="cf-watch-sub">
            {watch.brand ? <strong>{watch.brand}</strong> : null}
            {watch.brand && watch.model ? " · " : null}
            {watch.model ? <span>{watch.model}</span> : null}
          </p>
          <ul class="cf-watch-meta" aria-label="Watch details">
            <li>
              <span class="cf-watch-meta__label">Owner</span>{" "}
              <a href={`/u/${watch.owner_username}`}>@{watch.owner_username}</a>
            </li>
            {watch.movement_canonical_name && watch.movement_id ? (
              <li>
                <span class="cf-watch-meta__label">Movement</span>{" "}
                <a href={`/m/${watch.movement_id}`}>{watch.movement_canonical_name}</a>
              </li>
            ) : null}
          </ul>
        </section>

        <section class="cf-container cf-section cf-watch-grid" aria-label="Watch summary">
          <WatchPhoto watch={watch} />
          <StatsPanel stats={session_stats} />
        </section>

        <section class="cf-container cf-section" aria-labelledby="chart-title">
          <h2 id="chart-title" class="cf-watch-h2">
            Deviation over time
          </h2>
          {readings.length === 0 ? (
            <p class="cf-watch-empty">
              No readings logged yet. The chart shows up once the owner records a
              baseline.
            </p>
          ) : (
            <DeviationChart readings={readings} />
          )}
        </section>

        <section class="cf-container cf-section" aria-labelledby="history-title">
          <h2 id="history-title" class="cf-watch-h2">
            Reading history
          </h2>
          {readings.length === 0 ? (
            <p class="cf-watch-empty">Nothing to show yet.</p>
          ) : (
            <HistoryTable readings={readings} />
          )}
        </section>

        <section class="cf-container cf-section">
          <a
            class="cf-btn cf-btn--primary"
            href={chrono24Href}
            rel="sponsored nofollow noopener"
            target="_blank"
          >
            Buy one like this on Chrono24 →
          </a>
        </section>
      </main>
      <Footer />
    </Layout>
  );
};

export const WatchNotFoundPage = ({ watchId }: { watchId: string }) => (
  <Layout
    title="Watch not found — rated.watch"
    description="No public watch with that id."
    pathname={`/w/${watchId}`}
  >
    <WatchPageStyles />
    <Header />
    <main>
      <section class="cf-container cf-hero" aria-labelledby="nf-title">
        <h1 id="nf-title">Watch not found</h1>
        <p class="cf-watch-sub">
          This watch doesn't exist, or its owner hasn't made it public. Browse the{" "}
          <a href="/leaderboard">leaderboard</a> or head <a href="/">home</a>.
        </p>
      </section>
    </main>
    <Footer />
  </Layout>
);

function WatchPhoto({ watch }: { watch: PublicWatch }) {
  if (watch.has_image) {
    return (
      <div class="cf-watch-photo">
        <img
          src={`/images/watches/${watch.watch_id}`}
          alt={formatWatchLabel({
            name: watch.name,
            brand: watch.brand,
            model: watch.model,
          })}
          loading="lazy"
        />
      </div>
    );
  }
  return (
    <div class="cf-watch-photo cf-watch-photo--placeholder" aria-hidden="true">
      <span>No photo</span>
    </div>
  );
}

function StatsPanel({ stats }: { stats: SessionStats }) {
  const verifiedPct = (stats.verified_ratio * 100).toFixed(0);
  return (
    <dl class="cf-watch-stats">
      <div>
        <dt>Drift</dt>
        <dd>{formatDriftRate(stats.avg_drift_rate_spd)}</dd>
      </div>
      <div>
        <dt>Session</dt>
        <dd>{stats.session_days.toFixed(1)} days</dd>
      </div>
      <div>
        <dt>Readings</dt>
        <dd>{String(stats.reading_count)}</dd>
      </div>
      <div>
        <dt>Verified</dt>
        <dd>
          {verifiedPct}%{" "}
          {stats.verified_badge ? (
            <span
              class="cf-lb-badge"
              title="25 %+ verified readings this session"
              data-verified-badge="true"
            >
              <span class="cf-lb-badge__check" aria-hidden="true">
                ✓
              </span>{" "}
              Badge
            </span>
          ) : null}
        </dd>
      </div>
    </dl>
  );
}

function HistoryTable({ readings }: { readings: readonly Reading[] }) {
  // Most-recent first for the human-readable table; the chart above
  // uses the same underlying array in the time-ascending form.
  const descending = [...readings].sort(
    (a, b) => b.reference_timestamp - a.reference_timestamp,
  );
  return (
    <table class="cf-watch-history">
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col" class="cf-watch-history__num">
            Deviation
          </th>
          <th scope="col">Verified</th>
          <th scope="col">Note</th>
        </tr>
      </thead>
      <tbody>
        {descending.map((r) => (
          <tr>
            <td>
              <time dateTime={new Date(r.reference_timestamp).toISOString()}>
                {formatReadingDate(r.reference_timestamp)}
              </time>
            </td>
            <td class="cf-watch-history__num">
              {formatSignedSeconds(r.deviation_seconds)}
            </td>
            <td>
              {r.verified ? (
                <span class="cf-lb-badge">✓</span>
              ) : (
                <span class="cf-lb-badge cf-lb-badge--muted">—</span>
              )}
            </td>
            <td>{r.is_baseline ? <em>Baseline</em> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatReadingDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatSignedSeconds(s: number): string {
  if (!Number.isFinite(s)) return "—";
  if (s === 0) return "0.0 s";
  const sign = s > 0 ? "+" : "";
  return `${sign}${s.toFixed(1)} s`;
}

function WatchPageStyles() {
  const css = `
.cf-watch-sub {
  color: var(--cf-text-muted);
  font-size: 1.125rem;
  margin: 0 0 16px;
}
.cf-watch-sub strong {
  color: var(--cf-text);
  font-weight: 500;
}

.cf-watch-meta {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 16px 24px;
  font-size: 0.95rem;
  color: var(--cf-text-muted);
}
.cf-watch-meta__label {
  font-size: 0.7rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--cf-text-subtle);
  margin-right: 6px;
}

.cf-watch-h2 {
  font-size: 1.25rem;
  font-weight: 500;
  letter-spacing: -0.01em;
  margin: 0 0 16px;
}

.cf-watch-empty {
  color: var(--cf-text-muted);
  margin: 0;
}

.cf-watch-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 24px;
}
@media (min-width: 768px) {
  .cf-watch-grid { grid-template-columns: minmax(240px, 320px) 1fr; }
}

.cf-watch-photo {
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-lg);
  overflow: hidden;
  background: var(--cf-bg-200);
  aspect-ratio: 1 / 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cf-watch-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cf-watch-photo--placeholder {
  color: var(--cf-text-subtle);
  font-size: 0.95rem;
}

.cf-watch-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin: 0;
  padding: 24px;
  background: var(--cf-bg-200);
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-lg);
}
@media (min-width: 768px) {
  .cf-watch-stats { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
.cf-watch-stats > div { margin: 0; }
.cf-watch-stats dt {
  font-size: 0.7rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--cf-text-subtle);
  margin-bottom: 4px;
}
.cf-watch-stats dd {
  margin: 0;
  font-family: var(--cf-font-mono);
  font-size: 1rem;
}

.cf-deviation-chart {
  width: 100%;
  height: auto;
  background: var(--cf-bg-200);
  border: 1px solid var(--cf-border);
  border-radius: var(--cf-radius-lg);
}
.cf-deviation-chart__axes line {
  stroke: var(--cf-border);
  stroke-width: 1;
}
.cf-deviation-chart__line {
  stroke: var(--cf-orange);
  stroke-width: 2;
}
.cf-deviation-chart__dot {
  fill: var(--cf-orange);
  stroke: var(--cf-bg-200);
  stroke-width: 1;
}
.cf-deviation-chart__dot--verified {
  fill: var(--cf-orange-hover);
  stroke-width: 2;
}

.cf-watch-history {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.95rem;
}
.cf-watch-history thead th {
  text-align: left;
  padding: 12px;
  border-bottom: 1px solid var(--cf-border);
  font-weight: 500;
  color: var(--cf-text-muted);
  font-size: 0.85rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.cf-watch-history tbody td {
  padding: 12px;
  border-bottom: 1px solid var(--cf-border-light);
  vertical-align: middle;
}
.cf-watch-history__num {
  font-family: var(--cf-font-mono);
  text-align: right;
  white-space: nowrap;
}

.cf-lb-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
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
.cf-lb-badge__check {
  font-weight: 700;
  line-height: 1;
}
`;
  return <style>{css}</style>;
}
