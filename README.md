# rated.watch

Competitive accuracy-tracking platform for watch enthusiasts.

Log readings of how far your mechanical or quartz watch drifts from accurate time. Compete on leaderboards grouped by movement caliber (ETA 2892, Seiko 6R35, Rolex 3235, …). AI-verified readings from in-app camera capture prevent cheating; a watch earns the *verified* badge when enough of its recent readings are camera-proven.

**Status:** pre-alpha — under active rebuild. See the [project PRD](../../issues/1) for the current vision and scope. The prior vibe-coded prototype (codename _watchdrift_) has been archived and is no longer being developed.

## Stack

| Layer | Choice |
|---|---|
| Public SEO pages | Hono + `hono/jsx` server-rendered on Workers |
| Authed app | Vite + React SPA |
| Backend | Hono Worker |
| Data access | Kysely → Cloudflare D1 |
| Auth | Better Auth (email/password + Google OAuth) |
| Validation | Zod at API boundaries |
| Storage | Cloudflare R2 (watch photos) |
| AI | Workers AI — LLaMA 3.2 Vision (dial reading) |
| Styling | Tailwind + the CF Workers design system |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` + Playwright |
| Observability | Workers Logs + Sentry + Analytics Engine + Logpush → R2 |
| Deploy | Terraform (infra) + Wrangler (Worker) |

## Local development

Scaffolding in progress. Run targets will be documented as each slice lands.

## License

[MIT](LICENSE)
