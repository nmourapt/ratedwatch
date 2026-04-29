# rated.watch — Agent context

This file provides repo-specific instructions to AI agents (OpenCode, Claude Code, Codex, etc.) working in this project. Complements, does not replace, the user's global `~/AGENTS.md`.

## Product one-liner

**rated.watch** is a competitive accuracy-tracking platform for watch enthusiasts. Watches compete on leaderboards grouped by movement caliber. Revenue thesis: Chrono24 affiliate links on movement pages (stubbed as plain search URLs in phase 1).

Full product spec: see the `product-requirements` issue labelled `prd` on GitHub (currently [#1](../../issues/1)).

## Ubiquitous language

| Term                          | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reading**                   | A record of the watch's displayed time vs an authoritative reference time at a specific moment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Deviation**                 | Signed seconds the watch is ahead (+) or behind (−) of the reference, at a single reading.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Drift rate**                | Change in deviation per day, computed between two readings. Unit: seconds per day (s/d).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Baseline reading**          | A reading with `is_baseline = true`, marking the start of a new tracking session (watch just set to the exact time; deviation is 0).                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Session**                   | The sequence of readings from the most recent baseline to the latest reading for a given watch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Manual reading**            | A reading whose deviation was typed by the user. Not trusted for competitive rankings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Verified reading**          | A reading whose deviation was computed from an in-app camera capture. Reference time is the photo's EXIF `DateTimeOriginal` when present (bounded against server arrival, ±5 min / +1 min); falls back to server arrival time when EXIF is absent. See the trust note in "Things NOT to do".                                                                                                                                                                                                                                                                                                   |
| **Verified watch**            | A watch whose current session has at least 25 % verified readings. Displays a verified badge on leaderboards.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Dial reader**               | The CV pipeline that turns a verified-reading photo into a structured `mm_ss: { m, s }` pair. As of slice #4 of PRD #99 (issue #103), it's a Worker-side hybrid: HoughCircles dial detection + 768×768 crop in `src/domain/dial-cropper/` (using `env.IMAGES`), then a single VLM read against `openai/gpt-5.2` via AI Gateway in `src/domain/dial-reader-vlm/`. Orchestrated by `src/domain/reading-verifier/verifier.ts`. The verifier owns the hour (from the reference clock) — the dial reader returns MM:SS only because the 12-hour wrap on a watch dial makes hour readings ambiguous. |
| **Movement** (or **caliber**) | The mechanical/quartz/electronic time-keeping mechanism inside a watch. First-class domain object. Leaderboards are grouped by movement.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Stack + conventions

- **Language:** TypeScript, strict mode, ES2022+.
- **Runtime:** Cloudflare Workers. Never assume Node APIs.
- **HTTP routing:** Hono. Module per domain area (`routes/auth.ts`, `routes/watches.ts`, …).
- **Public SSR:** `hono/jsx` for server-rendered public pages (`/`, `/leaderboard`, `/m/:id`, `/u/:name`, `/w/:id`). No client runtime on public pages.
- **Authed SPA:** Vite + React at `/app/*`. Served via Workers Assets.
- **Data access:** Kysely (`kysely-d1` dialect) with a single generated `Database` type. No raw `db.prepare(...)` outside the data layer.
- **Auth:** Better Auth with its Kysely adapter. Own tables live in the same D1. Never roll custom session code.
- **Validation:** Zod schemas at every API boundary (request body, query, form). Compose request-type and response-type from the schemas.
- **Styling:** Tailwind + the CF Workers design system tokens (see user's `~/design/CF-WORKERS-DESIGN.md`). Never pure white backgrounds or pure black text.
- **Tests:**
  - Unit: Vitest for pure functions (drift calc, scoring, EXIF parsing, zod parsing).
  - Integration: `@cloudflare/vitest-pool-workers` for Worker + D1 + R2 end-to-end. Real Miniflare runtime.
  - E2E: Playwright against a deployed preview.
  - Tests live next to source (`foo.test.ts` beside `foo.ts`) for unit, and in `tests/integration/**` / `tests/e2e/**` for the other tiers.
- **Feature flags:** KV-backed, single service with `isEnabled(flag, ctx)` signature. Default to off.
- **Secrets:** `wrangler secret put` for Worker-side secrets; `.dev.vars` for local dev (gitignored). Never hardcode. Required production secrets:
  - `BETTER_AUTH_SECRET` — 32+ char high-entropy value used by Better Auth for cookie signing. Set once per environment with `wrangler secret put BETTER_AUTH_SECRET` **before** any `wrangler deploy`. Generate with `openssl rand -base64 32`.
  - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — OAuth 2.0 client credentials from the Google Cloud Console ("APIs & Services → Credentials → Create OAuth client ID → Web application"). Set both via `wrangler secret put` before any `wrangler deploy` that needs Google sign-in. Preview deploys inherit Worker secrets, so provisioning once covers both prod and subsequent `pr-<N>` previews. Authorized redirect URIs to configure on the Google client:
    - Production: `https://ratedwatch.nmoura.workers.dev/api/v1/auth/callback/google`
    - Previews: `https://pr-<N>-ratedwatch.nmoura.workers.dev/api/v1/auth/callback/google` — Google does **not** allow wildcard redirect URIs, so each preview number has to be pre-registered. Pragmatic workaround: register a generous pool up front (e.g. `pr-1` through `pr-50`) when you provision the client, or add new ones on demand as PRs open.
      When the secrets are not set the Worker boots cleanly but the Google social provider is not registered — `POST /api/v1/auth/sign-in/social` returns 404 "provider not found". Email+password flows continue to work so an un-provisioned preview is still useful for non-OAuth testing.
  - `SENTRY_DSN` — Sentry DSN consumed by the Worker (`withSentry` in `src/observability/sentry.ts`). Set with `wrangler secret put SENTRY_DSN`. Missing DSN is a no-op — the wrapper degrades to a passthrough so local dev and freshly-provisioned previews boot cleanly without it. Worker errors land tagged `service=ratedwatch`.
- **Infra as code:** Terraform owns zone, route, D1, R2 bucket, access policies. Wrangler owns the Worker script. No overlap. State in the user's nmoura.cf R2 backend if possible.
- **D1 migrations:** Live at `migrations/NNNN_*.sql`. Applied to the production D1 via `wrangler d1 migrations apply rated-watch-db --remote` **before** `wrangler deploy` whenever a PR introduces a new migration. Tests use miniflare which auto-applies migrations via `vitest.config.ts`; preview deploys use the real D1 and therefore require the migration to have run against production first. Any slice that adds a migration should call this out in its PR body so the operator runs it at merge time.
- **Verified-reading dial reader:** Worker-side hybrid pipeline. `POST /api/v1/watches/:id/readings/verified` runs an uploaded photo through (1) `src/domain/dial-cropper/` — JS HoughCircles dial detection + `env.IMAGES` (Cloudflare Images) for HEIC decode / EXIF rotation / 1024-px-long-edge resize / final 768×768 crop — then (2) `src/domain/dial-reader-vlm/` — a single VLM read against `openai/gpt-5.2` via Cloudflare AI Gateway, prompted with chain-of-thought hand-identification + an EXIF anchor (sanity check, not echoed). The orchestrator at `src/domain/reading-verifier/verifier.ts` resolves the reference timestamp from EXIF DateTimeOriginal (bounded ±5min/+1min vs server arrival; falls back to server arrival when EXIF is missing), runs the cropper + reader, and computes a signed MM:SS-modulo-30min deviation against the reference clock. Single VLM call for now; median-of-3 + the anchor-disagreement guard land in slice #5 of PRD #99. The bake-off harness lives at `scripts/vlm-bakeoff/` and is the canonical reference for prompt/crop/model tuning. The `verified_reading_cv` flag in KV is still gating this in production at `mode:never` until slice #10's rollout. The `manual_with_photo` companion route remains a 503 stub until a later slice of PRD #99 rebuilds it. The previous Python `container/dial-reader/` subtree, the `DIAL_READER` Durable Object binding, the `VERIFIED_READING_LIMITER` ratelimit, the `@/domain/dial-reader/` Worker adapter, and the `dial_reader_*` Analytics Engine events were all removed in slice #1 of PRD #99 (issue #100). Slice #4 (issue #103) wired the VLM pipeline back into the verified-reading route.

## Things NOT to do

- **No React Native / Expo in this repo.** A separate future repo will host the native app; both hit the same Worker API.
- **No Next.js, Remix, TanStack Start, or other SSR frameworks** — the Hono JSX + Vite SPA split is the architecture.
- **No Prisma, Sequelize, or heavy ORMs.** Kysely only.
- **No rolling our own crypto.** Better Auth handles all auth primitives; never touch PBKDF2 / JWT hand-crafted code like the archived watchdrift prototype did.
- **No rolling our own image-format decoders** — use Pillow + pillow-heif. Magic-byte sniffing for format detection is fine (clients lie about Content-Type), but actual decode dispatches into Pillow / pillow-heif inside the dial-reader container.
- **EXIF DateTimeOriginal is accepted as the reference timestamp** for verified readings, bounded by ±5 min / +1 min against server arrival time. Reading the bytes server-side is fine; the client never sends a literal timestamp claim. When EXIF is missing the verifier falls back to server arrival time (captured at handler entry, **before** body upload, to minimize phantom drift). The trust trade-off is that an attacker with control over their phone's clock can fake deviations within the bounds window — that's accepted for now; spoof-resistance (e.g. camera-attestation tokens) is a future iteration.
- **No placeholder strings in committed config** (e.g. `YOUR_WORKER_URL.workers.dev` — that's an archived-watchdrift crime).

## CI / quality gates

- Pre-commit: lint-staged with Prettier + typecheck (Worker + SPA + E2E tsconfigs) + `vitest related`.
- CI: GitHub Actions — `verify` (typecheck, build, unit + integration tests, coverage) → `preview` (Wrangler `versions upload --preview-alias=pr-<N>`) → `e2e-smoke` (Playwright against the preview URL). Preview + E2E only run on `pull_request`; `main` pushes skip them.
- Husky + `lint-staged` wired from day one.
- When adding an E2E test, put it under `tests/e2e/` (own `tsconfig.e2e.json`; uses `@playwright/test` + DOM). Keep specs few — use integration tests for single-route behaviour.

## AI Gateway operator runbook

Two Cloudflare AI Gateways live in the Babybites account:

- **`ratedwatch-vlm`** (production) — Terraform-managed, defined in `infra/terraform/ai-gateway.tf`. Used by `wrangler deploy --env=production` (the `npm run deploy` script).
- **`dial-reader-bakeoff`** (everything else) — created by hand during the PRD #99 bake-off, intentionally NOT in Terraform. Used by local dev, integration tests, and CI preview deploys (`wrangler versions upload --preview-alias=pr-<N>` without `--env`).

Both gateways share the same Cloudflare-account unified-billing credit pool, so credits loaded once cover both. The split exists so log volume, cache stats, and future per-gateway policies can diverge between dev and prod without touching the bake-off sandbox.

### Initial provisioning of `ratedwatch-vlm`

1. From `infra/terraform/`:
   ```bash
   terraform init
   terraform plan    # review the cloudflare_ai_gateway.ratedwatch_vlm resource
   terraform apply   # creates the gateway with authentication=true, collect_logs=true, etc.
   ```
2. The provider at version `5.19.0-beta.5` (pinned in `main.tf`) does NOT expose the `wholesale` attribute. Operator must flip the flag manually after `terraform apply`:
   ```bash
   curl -X PUT \
     "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/gateways/ratedwatch-vlm" \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     -H "Content-Type: application/json" \
     --data '{
       "id": "ratedwatch-vlm",
       "cache_invalidate_on_update": true,
       "cache_ttl": 0,
       "collect_logs": true,
       "rate_limiting_interval": 0,
       "rate_limiting_limit": 0,
       "authentication": true,
       "wholesale": true
     }'
   ```
3. Verify both critical flags are set:
   ```bash
   curl -s \
     "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/gateways/ratedwatch-vlm" \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     | jq '.result | {authentication, wholesale, collect_logs}'
   ```
   Expected: `{ "authentication": true, "wholesale": true, "collect_logs": true }`. The bake-off discovered that without `authentication = true` the gateway forwards requests without injecting upstream credentials and the model returns "Missing or invalid Authorization header" — non-obvious and easy to miss.
4. Load credits via the dashboard at <https://dash.cloudflare.com/?to=/:account/ai/ai-gateway>. Recommended initial budget: **$50**. Set an auto-top-up alert at **$10 remaining** (also via the dashboard — there's no API for this).

### Verifying production after deploy

After `npm run deploy` (which runs `wrangler deploy --env=production`):

```bash
curl -s https://rated.watch/api/v1/_health      # smoke the deploy itself
# Then check AI Gateway logs in the dashboard for a successful Workers-AI run
# tagged with the ratedwatch-vlm gateway slug.
```

### Rotating the gateway slug

If the slug is compromised (e.g. published in a screenshot, used in a leaked Worker secret-by-mistake):

1. Create a new gateway slug via Terraform — change `id` in `ai-gateway.tf` (this triggers `RequiresReplace`, so Terraform will destroy the old gateway and create a fresh one).
2. Update `env.production.vars.AI_GATEWAY_ID` in `wrangler.jsonc` to match.
3. `npm run deploy`.
4. Re-run the manual `wholesale = true` flip on the new gateway.
5. Re-load credits + auto-top-up alert (credits are per-account, not per-gateway, so this step is usually a no-op).

The bake-off gateway (`dial-reader-bakeoff`) is unaffected by the rotation — keep it as-is unless you also need to rotate it (in which case do it via the dashboard, since it's not in Terraform).

## How to work in this repo

1. Read this file AND the PRD issue before starting anything.
2. For any non-trivial change, write the failing test FIRST (red → green → refactor loop from the `tdd` skill).
3. Keep each commit tiny. Each commit should leave the tree in a state where `npm run test` passes.
4. Public pages belong in `src/public/` (Hono JSX). Authed SPA code belongs in `src/app/`. Shared domain logic (drift calc, scoring, types) belongs in `src/domain/`. API handlers in `src/server/routes/`.
5. PR before merge. Merge to `main` triggers production deploy.

## Glossary of routes (planned)

| Path             | Kind        | Purpose                                                |
| ---------------- | ----------- | ------------------------------------------------------ |
| `/`              | public HTML | Marketing / top-watches hero.                          |
| `/leaderboard`   | public HTML | Global verified leaderboard.                           |
| `/m/:movementId` | public HTML | Per-movement leaderboard, Chrono24 CTA.                |
| `/u/:username`   | public HTML | Public user profile, their watches.                    |
| `/w/:watchId`    | public HTML | Public watch page, reading history chart.              |
| `/app/*`         | SPA         | Authed dashboard, add watch, log readings.             |
| `/api/v1/*`      | JSON        | REST API consumed by the SPA and (later) the Expo app. |
| `/api/v1/auth/*` | JSON        | Better Auth routes.                                    |
