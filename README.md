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

Prerequisites: Node 22+ and npm. Clone, then:

```bash
npm install
```

### Run targets

| Command | What it does |
|---|---|
| `npm run dev` | Starts `wrangler dev` (Worker) and `vite` (SPA) concurrently |
| `npm run dev:worker` | Worker only, on http://localhost:8787 |
| `npm run dev:vite` | Vite dev server only, for fast SPA iteration |
| `npm run build` | `vite build` — produces `dist/` with the SPA bundle |
| `npm run test` | Runs Vitest with `@cloudflare/vitest-pool-workers` (integration tests) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run typecheck` | `tsc --noEmit` for both the Worker and the SPA configs |
| `npm run types:gen` | Regenerates `worker-configuration.d.ts` from `wrangler.jsonc` |
| `npm run types:check` | Verifies the committed types are in sync with `wrangler.jsonc` (CI runs this) |
| `npm run deploy` | Builds the SPA, then `wrangler deploy` |

### Secrets and environment variables

- **Worker runtime secrets** (JWT keys, Google OAuth client secret, Sentry DSN, etc.) go in `wrangler secret put <KEY>` for production and `.dev.vars` for local dev. Both are gitignored.
- **Local tooling vars** (Terraform, scripts, CI bootstrap) live in `.env`, copied from `.env.example`. `.env` is *not* a source of Worker runtime vars — wrangler is explicitly configured (via `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` in every npm script that invokes it) to skip it.

### Project layout

```
src/
  worker/     Worker entry — Hono app composition
  server/     API handlers (/api/*)
  public/     Public SSR pages (hono/jsx)
  domain/     Shared domain logic (drift calc, scoring, types)
  db/         Data layer (Kysely)
  schemas/    Zod schemas
  app/        Vite + React SPA
tests/
  integration/  Vitest + @cloudflare/vitest-pool-workers
  e2e/          Playwright (later slice)
```

See [AGENTS.md](AGENTS.md) for the full stack rationale and conventions.

## License

[MIT](LICENSE)
