# rated.watch

Competitive accuracy-tracking platform for watch enthusiasts.

Log readings of how far your mechanical or quartz watch drifts from accurate time. Compete on leaderboards grouped by movement caliber (ETA 2892, Seiko 6R35, Rolex 3235, …). AI-verified readings from in-app camera capture prevent cheating; a watch earns the _verified_ badge when enough of its recent readings are camera-proven.

**Status:** pre-alpha — under active rebuild. See the [project PRD](../../issues/1) for the current vision and scope. The prior vibe-coded prototype (codename _watchdrift_) has been archived and is no longer being developed.

## Stack

| Layer            | Choice                                                  |
| ---------------- | ------------------------------------------------------- |
| Public SEO pages | Hono + `hono/jsx` server-rendered on Workers            |
| Authed app       | Vite + React SPA                                        |
| Backend          | Hono Worker                                             |
| Data access      | Kysely → Cloudflare D1                                  |
| Auth             | Better Auth (email/password + Google OAuth)             |
| Validation       | Zod at API boundaries                                   |
| Storage          | Cloudflare R2 (watch photos)                            |
| AI               | Workers AI — LLaMA 3.2 Vision (dial reading)            |
| Styling          | Tailwind + the CF Workers design system                 |
| Tests            | Vitest + `@cloudflare/vitest-pool-workers` + Playwright |
| Observability    | Workers Logs + Sentry + Analytics Engine + Logpush → R2 |
| Deploy           | Terraform (infra) + Wrangler (Worker)                   |

## Local development

Prerequisites: Node 22+ and npm. Clone, then:

```bash
npm install
```

### Run targets

| Command                 | What it does                                                                  |
| ----------------------- | ----------------------------------------------------------------------------- |
| `npm run dev`           | Starts `wrangler dev` (Worker) and `vite` (SPA) concurrently                  |
| `npm run dev:worker`    | Worker only, on http://localhost:8787                                         |
| `npm run dev:vite`      | Vite dev server only, for fast SPA iteration                                  |
| `npm run build`         | `vite build` — produces `dist/` with the SPA bundle                           |
| `npm run test`          | Runs Vitest with `@cloudflare/vitest-pool-workers` (integration tests)        |
| `npm run test:watch`    | Vitest in watch mode                                                          |
| `npm run test:coverage` | Vitest with Istanbul coverage — writes `coverage/` (text + HTML + JSON)       |
| `npm run test:e2e`      | Runs Playwright against `PLAYWRIGHT_BASE_URL` (defaults to `localhost:8787`)  |
| `npm run typecheck`     | `tsc --noEmit` for both the Worker and the SPA configs                        |
| `npm run format`        | Prettier writes the whole tree                                                |
| `npm run format:check`  | Prettier check mode — fails if anything is unformatted                        |
| `npm run types:gen`     | Regenerates `worker-configuration.d.ts` from `wrangler.jsonc`                 |
| `npm run types:check`   | Verifies the committed types are in sync with `wrangler.jsonc` (CI runs this) |
| `npm run deploy`        | Builds the SPA, then `wrangler deploy`                                        |

### Secrets and environment variables

- **Worker runtime secrets** (JWT keys, Google OAuth client secret, Sentry DSN, etc.) go in `wrangler secret put <KEY>` for production and `.dev.vars` for local dev. Both are gitignored.
- **Local tooling vars** (Terraform, scripts, CI bootstrap) live in `.env`, copied from `.env.example`. `.env` is _not_ a source of Worker runtime vars — wrangler is explicitly configured (via `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` in every npm script that invokes it) to skip it.

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
  e2e/          Playwright — browser-level smoke tests
```

### End-to-end tests (Playwright)

The integration suite covers the API and SPA shell in-process (vitest +
Miniflare). For flows that need a real browser — JS execution, React
Router redirects, cookie persistence — we use Playwright against a live
Worker:

```bash
npm run dev                 # terminal 1: wrangler dev on :8787 + vite
npm run test:e2e            # terminal 2: runs tests/e2e/*.test.ts
```

The first run downloads Chromium via `npx playwright install
--with-deps chromium`. Browser bundles are not tracked in the lockfile
and don't ship in CI-bound `npm ci` installs; CI runs the same
`playwright install` step in the `e2e-smoke` job.

E2E specs live under `tests/e2e/`, have their own tsconfig
(`tsconfig.e2e.json`) and are intentionally few. Single-route
behaviour belongs in `tests/integration/`; E2E is reserved for
genuinely cross-boundary assertions.

### CI preview deploys

Every pull request against `main` triggers a Wrangler preview
deployment: the workflow uploads a new Worker _version_ (via
`wrangler versions upload --preview-alias=pr-<N>`) and exposes a
stable URL of the form `https://pr-<N>-ratedwatch.<subdomain>.workers.dev`.
The Playwright `e2e-smoke` job then runs against that URL.

Required repository-level secrets (operator provisions once, in
**Settings → Secrets and variables → Actions → New repository secret**):

| Secret                  | Value                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`  | The same scoped token currently in `.env` as `CLOUDFLARE_API_TOKEN`. Needs `Workers Scripts:Edit`.     |
| `CLOUDFLARE_ACCOUNT_ID` | The account ID hosting the `ratedwatch` Worker. Non-sensitive but kept as a secret to keep logs clean. |

Worker-side runtime secrets (operator provisions once, via Wrangler):

```bash
# Run from a trusted workstation with the scoped API token loaded.
# Subsequent version uploads inherit these secrets automatically —
# no per-PR provisioning needed.
wrangler secret put BETTER_AUTH_SECRET
# paste a 32+ char value from `openssl rand -base64 32`

# Google OAuth (slice 5). Obtain both from the Google Cloud Console:
#   APIs & Services → Credentials → Create OAuth client ID
#   → "Web application" → add the Authorized Redirect URIs below.
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

Authorized Redirect URIs to register on the Google OAuth client:

- Production: `https://ratedwatch.nmoura.workers.dev/api/v1/auth/callback/google`
- Previews: `https://pr-<N>-ratedwatch.nmoura.workers.dev/api/v1/auth/callback/google`

Google does not support wildcard redirect URIs, so each preview number
has to be pre-registered (register a pool like `pr-1` … `pr-50` up
front, or add URIs on demand). When the Google pair is not yet set
the Worker still boots cleanly — email+password sign-in keeps working
and Google sign-in attempts return 404 "provider not found".

**Branch protection (manual GH UI step).** Once the workflow above is
green on a PR, enable branch protection on `main`:

1. Settings → Branches → Add branch ruleset (or Branch protection rule)
   targeting `main`.
2. Required status checks before merging — pick these from the dropdown:
   - `Typecheck, build, test`
   - `Preview deploy`
   - `E2E smoke`
3. Require branches to be up to date before merging: **on**.
4. Require a pull request before merging: **on** (1 approval; stricter
   as team grows).

This cannot be scripted via `gh` reliably (the GitHub API for rulesets
is inconsistent between UI and CLI for required-check names, which
vary by job display name). Keep this paragraph in sync with the job
names in `.github/workflows/ci.yml`.

### Pre-commit hook

`npm install` wires Husky and a `lint-staged` pre-commit hook. On every commit
it runs, for staged files only:

- `prettier --write` over JS/TS/TSX/JSON/JSONC/MD/YML/YAML
- `tsc --noEmit` against the Worker, the SPA, and the E2E tsconfigs
  (full-project; the type graph can't be checked per-file)
- `vitest related --run` against changed TS/TSX files

If any of these fail, the commit is aborted and the original worktree state is
restored. To bypass in an emergency, use `git commit --no-verify` — but CI runs
the same gates and will block the PR.

See [AGENTS.md](AGENTS.md) for the full stack rationale and conventions.

## License

[MIT](LICENSE)
