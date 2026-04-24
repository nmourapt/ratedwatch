// SEO plumbing — robots.txt + sitemap.xml.
//
// Both routes are owned by the Worker (see run_worker_first in
// wrangler.jsonc). The SPA fallback would otherwise rewrite unknown
// paths to /index.html, which is wrong for crawler-facing surfaces:
// robots.txt would 200 with HTML, and sitemap.xml would never get
// served at all.
//
// Canonical host is always https://rated.watch in emitted URLs,
// regardless of the hostname the request hit. The Worker is reachable
// at multiple hostnames (rated.watch, ratedwatch.nmoura.workers.dev,
// per-PR pr-<N>-… preview aliases), but only the apex is the indexable
// surface — see wrangler.jsonc and src/server/auth.ts for the same
// reasoning applied to the auth baseURL.
//
// The sitemap is dynamic: it enumerates approved movements, users
// with at least one public watch, and public watches themselves. The
// query plan is one query per entity type (no N+1) and the result is
// edge-cached for an hour, so the per-request cost is bounded.

import { Hono } from "hono";
import { sql } from "kysely";
import { createDb } from "@/db";

type Bindings = { DB: D1Database; [key: string]: unknown };

// Canonical host. Phase 1 only — `www.rated.watch` is intentionally
// NOT a sitemap URL because crawlers would otherwise index two
// hostnames for the same content.
const CANONICAL_ORIGIN = "https://rated.watch";

// Static body. Reasons each line is here:
//   * `Allow: /` is a no-op (the default) but spelled out for human
//     readers who skim the file.
//   * /app/ is the authed SPA; nothing under it should be indexed.
//   * /api/ is the JSON surface; same reason, plus it dampens any
//     accidental crawler that decides to POST somewhere.
//   * /out/ is the click-tracker redirect surface; crawling it wastes
//     crawl budget on 302s and pollutes the analytics events.
const ROBOTS_TXT = `User-agent: *
Allow: /
Disallow: /app/
Disallow: /api/
Disallow: /out/
Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml
`;

export const seoRoute = new Hono<{ Bindings: Bindings }>();

seoRoute.get("/robots.txt", (c) => {
  c.header("Content-Type", "text/plain; charset=utf-8");
  // 24h edge cache — crawlers refetch this rarely; the directives are
  // stable across deploys.
  c.header("Cache-Control", "public, s-maxage=86400");
  return c.body(ROBOTS_TXT);
});

/**
 * XML-escape a string for use inside a `<loc>` element. The sitemap
 * spec mandates entity-encoding for `&`, `<`, `>`, `'`, `"`. We don't
 * URL-encode the whole thing because slugs and usernames are already
 * URL-safe by construction (lowercase + hyphen).
 */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface SitemapEntry {
  loc: string;
  lastmod?: string;
  changefreq?: "hourly" | "daily" | "weekly";
  priority?: number; // 0.0 - 1.0
}

function renderUrl(entry: SitemapEntry): string {
  const parts: string[] = [`    <loc>${xmlEscape(entry.loc)}</loc>`];
  if (entry.lastmod) {
    parts.push(`    <lastmod>${xmlEscape(entry.lastmod)}</lastmod>`);
  }
  if (entry.changefreq) {
    parts.push(`    <changefreq>${entry.changefreq}</changefreq>`);
  }
  if (entry.priority !== undefined) {
    parts.push(`    <priority>${entry.priority.toFixed(1)}</priority>`);
  }
  return `  <url>\n${parts.join("\n")}\n  </url>`;
}

function renderSitemap(entries: readonly SitemapEntry[]): string {
  const body = entries.map(renderUrl).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

seoRoute.get("/sitemap.xml", async (c) => {
  const db = createDb(c.env);

  // One query per entity type. Each query stays a single statement —
  // join-free where possible — so 1k watches + 10k users still finishes
  // well under the hourly cache window.

  // Approved movements only (matches the /m/:id 404 rule for pending).
  const movements = await db
    .selectFrom("movements")
    .select("id")
    .where("status", "=", "approved")
    .orderBy("id")
    .execute();

  // Users with at least one public watch. Subquery via DISTINCT keeps
  // this a single-table-scan with an index lookup — no join.
  const usersWithPublicWatches = await db
    .selectFrom("user")
    .select(["username"])
    .where(
      "id",
      "in",
      db.selectFrom("watches").select("user_id").where("is_public", "=", 1),
    )
    .orderBy("username")
    .execute();

  // Public watches with their `lastmod` candidates: latest reading
  // created_at (when one exists) or the watch's own created_at.
  // SQLite's MAX() over the readings join is computed in one query.
  const publicWatches = await db
    .selectFrom("watches")
    .leftJoin("readings", "readings.watch_id", "watches.id")
    .select([
      "watches.id as id",
      "watches.created_at as created_at",
      sql<string | null>`MAX(readings.created_at)`.as("latest_reading_created_at"),
    ])
    .where("watches.is_public", "=", 1)
    .groupBy("watches.id")
    .orderBy("watches.id")
    .execute();

  const entries: SitemapEntry[] = [
    {
      loc: `${CANONICAL_ORIGIN}/`,
      changefreq: "daily",
      priority: 1.0,
    },
    {
      loc: `${CANONICAL_ORIGIN}/leaderboard`,
      changefreq: "hourly",
      priority: 0.9,
    },
    ...movements.map<SitemapEntry>((m) => ({
      loc: `${CANONICAL_ORIGIN}/m/${m.id}`,
      changefreq: "daily",
      priority: 0.7,
    })),
    ...usersWithPublicWatches.map<SitemapEntry>((u) => ({
      loc: `${CANONICAL_ORIGIN}/u/${u.username}`,
      changefreq: "weekly",
      priority: 0.6,
    })),
    ...publicWatches.map<SitemapEntry>((w) => ({
      loc: `${CANONICAL_ORIGIN}/w/${w.id}`,
      lastmod: w.latest_reading_created_at ?? w.created_at,
      changefreq: "weekly",
      priority: 0.6,
    })),
  ];

  c.header("Content-Type", "application/xml; charset=utf-8");
  // 1h edge cache — short enough that a fresh public watch lands in
  // the sitemap within an hour, long enough that crawler hits don't
  // pound the DB.
  c.header("Cache-Control", "public, s-maxage=3600");
  return c.body(renderSitemap(entries));
});
