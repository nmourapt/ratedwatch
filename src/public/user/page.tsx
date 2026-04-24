// Public user profile page. SSR via hono/jsx — zero client JS.
//
// Route: GET /u/:username (case-insensitive; non-canonical casing is
// 301'd to the lowercased form by the handler before we ever render).
//
// The grid of watch cards reuses the formatDriftRate + formatWatchLabel
// helpers from the leaderboard surface so the rendered copy matches
// 1:1 with what a visitor sees on /leaderboard.

import { formatDriftRate, formatWatchLabel } from "../leaderboard/format";
import { Footer } from "../components/footer";
import { Header } from "../components/header";
import { Layout } from "../components/layout";
import type { ProfileData } from "./load";

export interface UserPageProps {
  profile: ProfileData;
}

export const UserPage = ({ profile }: UserPageProps) => {
  const title = `@${profile.canonical_username} on rated.watch`;
  const description = `${profile.watches.length} ${profile.watches.length === 1 ? "watch" : "watches"} tracked — competitive accuracy for watch enthusiasts.`;
  return (
    <Layout
      title={title}
      description={description}
      pathname={`/u/${profile.canonical_username}`}
    >
      <UserPageStyles />
      <Header />
      <main>
        <section class="cf-container cf-hero" aria-labelledby="user-title">
          <h1 id="user-title">@{profile.canonical_username}</h1>
          <p class="cf-user-meta">
            Member since{" "}
            <time dateTime={profile.member_since}>
              {formatMemberSince(profile.member_since)}
            </time>
            . {profile.watches.length}{" "}
            {profile.watches.length === 1 ? "watch" : "watches"} tracked.
          </p>
        </section>

        <section class="cf-container cf-section" aria-label="Public watches">
          {profile.watches.length === 0 ? (
            <EmptyState username={profile.canonical_username} />
          ) : (
            <div class="cf-user-grid">
              {profile.watches.map((w) => (
                <WatchCard watch={w} />
              ))}
            </div>
          )}
        </section>
      </main>
      <Footer />
    </Layout>
  );
};

/**
 * 404 page for unknown usernames. Same <Layout> as the real profile so
 * the header + footer don't disappear — keeps the UX coherent when the
 * user mistypes or follows a stale share link.
 */
export const UserNotFoundPage = ({ username }: { username: string }) => (
  <Layout
    title="Profile not found — rated.watch"
    description="No watch enthusiast here by that username."
    pathname={`/u/${username}`}
  >
    <UserPageStyles />
    <Header />
    <main>
      <section class="cf-container cf-hero" aria-labelledby="nf-title">
        <h1 id="nf-title">Profile not found</h1>
        <p class="cf-user-meta">
          Nobody on rated.watch goes by <code>@{username}</code>. Try the{" "}
          <a href="/leaderboard">leaderboard</a> or{" "}
          <a href="/app/register">create an account</a>.
        </p>
      </section>
    </main>
    <Footer />
  </Layout>
);

function formatMemberSince(iso: string): string {
  // Defensive — if the stored string isn't a real ISO date we just
  // fall back to the raw value rather than throwing.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // "April 2026" style — precise day isn't useful here.
  return d.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function EmptyState({ username }: { username: string }) {
  return (
    <div class="cf-card">
      <div class="cf-brackets" aria-hidden="true">
        <span />
      </div>
      <h2 class="cf-card__title">No public watches yet</h2>
      <div class="cf-card__body">
        <p>
          @{username} hasn't made any of their watches public. When they do, the cards
          will show up here with their drift rate and verified badge.
        </p>
      </div>
    </div>
  );
}

function WatchCard({ watch }: { watch: import("./load").ProfileWatchCard }) {
  const label = formatWatchLabel({
    name: watch.name,
    brand: watch.brand,
    model: watch.model,
  });
  const stats = watch.session_stats;
  return (
    <a href={`/w/${watch.watch_id}`} class="cf-user-card">
      <div class="cf-brackets" aria-hidden="true">
        <span />
      </div>
      <div class="cf-user-card__title">{label}</div>
      {watch.movement_canonical_name && watch.movement_id ? (
        <div class="cf-user-card__movement">
          <a href={`/m/${watch.movement_id}`}>{watch.movement_canonical_name}</a>
        </div>
      ) : null}
      <dl class="cf-user-card__stats">
        <div>
          <dt>Drift</dt>
          <dd>{formatDriftRate(stats.avg_drift_rate_spd)}</dd>
        </div>
        <div>
          <dt>Readings</dt>
          <dd>{String(stats.reading_count)}</dd>
        </div>
        <div>
          <dt>Badge</dt>
          <dd>
            {stats.verified_badge ? (
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
              <span class="cf-lb-badge cf-lb-badge--muted">—</span>
            )}
          </dd>
        </div>
      </dl>
    </a>
  );
}

// Scoped stylesheet — reuses the `.cf-lb-badge` classes from the
// leaderboard surface for the verified pill so the visual language is
// identical.
function UserPageStyles() {
  const css = `
.cf-user-meta {
  color: var(--color-ink-muted);
  font-size: 1rem;
  margin: 0;
}
.cf-user-meta code {
  font-family: var(--font-mono);
  background: var(--color-surface);
  padding: 1px 6px;
  border-radius: var(--radius-tight);
}

.cf-user-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}
@media (min-width: 640px) {
  .cf-user-grid { grid-template-columns: repeat(2, 1fr); gap: 24px; }
}
@media (min-width: 1024px) {
  .cf-user-grid { grid-template-columns: repeat(3, 1fr); }
}

.cf-user-card {
  position: relative;
  display: block;
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  padding: 24px;
  color: var(--color-ink);
  transition: border-color 0.15s ease, background 0.15s ease;
}
.cf-user-card:hover {
  border-color: var(--color-accent);
  background: var(--color-surface-inset);
  color: var(--color-ink);
}
.cf-user-card__title {
  font-size: 1.125rem;
  font-weight: 500;
  letter-spacing: -0.01em;
  margin: 0 0 4px;
}
.cf-user-card__movement {
  color: var(--color-ink-muted);
  font-size: 0.9rem;
  margin-bottom: 16px;
}
.cf-user-card__movement a { color: inherit; }
.cf-user-card__movement a:hover { color: var(--color-accent); }

.cf-user-card__stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
}
.cf-user-card__stats > div { margin: 0; }
.cf-user-card__stats dt {
  font-size: 0.7rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-ink-subtle);
  margin-bottom: 4px;
}
.cf-user-card__stats dd {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.9rem;
}

.cf-lb-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  background: var(--color-accent);
  color: #FFFBF5;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.02em;
}
.cf-lb-badge--muted {
  background: transparent;
  color: var(--color-ink-subtle);
}
.cf-lb-badge__check {
  font-weight: 700;
  line-height: 1;
}
`;
  return <style>{css}</style>;
}
