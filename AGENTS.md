# rated.watch — Agent context

This file provides repo-specific instructions to AI agents (OpenCode, Claude Code, Codex, etc.) working in this project. Complements, does not replace, the user's global `~/AGENTS.md`.

## Product one-liner

**rated.watch** is a competitive accuracy-tracking platform for watch enthusiasts. Watches compete on leaderboards grouped by movement caliber. Revenue thesis: Chrono24 affiliate links on movement pages (stubbed as plain search URLs in phase 1).

Full product spec: see the `product-requirements` issue labelled `prd` on GitHub (currently [#1](../../issues/1)).

## Ubiquitous language

| Term                          | Meaning                                                                                                                                                                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reading**                   | A record of the watch's displayed time vs an authoritative reference time at a specific moment.                                                                                                                                                                                              |
| **Deviation**                 | Signed seconds the watch is ahead (+) or behind (−) of the reference, at a single reading.                                                                                                                                                                                                   |
| **Drift rate**                | Change in deviation per day, computed between two readings. Unit: seconds per day (s/d).                                                                                                                                                                                                     |
| **Baseline reading**          | A reading with `is_baseline = true`, marking the start of a new tracking session (watch just set to the exact time; deviation is 0).                                                                                                                                                         |
| **Session**                   | The sequence of readings from the most recent baseline to the latest reading for a given watch.                                                                                                                                                                                              |
| **Manual reading**            | A reading whose deviation was typed by the user. Not trusted for competitive rankings.                                                                                                                                                                                                       |
| **Verified reading**          | A reading whose deviation was computed from an in-app camera capture. Reference time is the photo's EXIF `DateTimeOriginal` when present (bounded against server arrival, ±5 min / +1 min); falls back to server arrival time when EXIF is absent. See the trust note in "Things NOT to do". |
| **Verified watch**            | A watch whose current session has at least 25 % verified readings. Displays a verified badge on leaderboards.                                                                                                                                                                                |
| **Movement** (or **caliber**) | The mechanical/quartz/electronic time-keeping mechanism inside a watch. First-class domain object. Leaderboards are grouped by movement.                                                                                                                                                     |

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
  - `SENTRY_DSN` — **shared** Sentry DSN used by both the Worker (`withSentry` in `src/observability/sentry.ts`) and the dial-reader Python container (`sentry_init.init` in `container/dial-reader/src/dial_reader/sentry_init.py`). Set once with `wrangler secret put SENTRY_DSN`; the Worker forwards the value into the container via the `envVars` block on `DialReaderContainer` in `src/worker/index.tsx`. Both sides degrade to a no-op when the DSN is missing — local dev, freshly-provisioned previews, and the pytest suite all boot cleanly. Container errors land in Sentry tagged `runtime=python`, `service=dial-reader-container`; Worker errors land tagged `service=ratedwatch`. Use the runtime tag to filter in the Sentry dashboard.
- **Container observability:** the dial-reader container emits one structured JSON log line per `/v1/read-dial` request via a `JsonFormatter` on the `dial_reader.requests` logger (see `container/dial-reader/src/dial_reader/http_app.py`). Cloudflare's container observability integration forwards stdout/stderr to Workers Logs automatically; the schema is `{event, reading_id, dial_reader_version, processing_ms, image_bytes, outcome, …}` where `outcome ∈ {success, rejection, malformed_image}`. The Worker-side dial-reader adapter (`src/domain/dial-reader/adapter.ts`) also emits five Analytics Engine events per call (`dial_reader_attempt` / `_success` / `_rejection` / `_error` / `_cold_start`); operator queries live at `scripts/dial-reader-analytics.sql`. The two streams correlate via `reading_id`, which the adapter forwards as the `x-reading-id` request header.
- **Infra as code:** Terraform owns zone, route, D1, R2 bucket, access policies. Wrangler owns the Worker script. No overlap. State in the user's nmoura.cf R2 backend if possible.
- **D1 migrations:** Live at `migrations/NNNN_*.sql`. Applied to the production D1 via `wrangler d1 migrations apply rated-watch-db --remote` **before** `wrangler deploy` whenever a PR introduces a new migration. Tests use miniflare which auto-applies migrations via `vitest.config.ts`; preview deploys use the real D1 and therefore require the migration to have run against production first. Any slice that adds a migration should call this out in its PR body so the operator runs it at merge time.
- **CV dial reader (Python container):** Lives at `container/dial-reader/` and runs as a Cloudflare Container behind the `DIAL_READER` Durable Object binding. Toolchain is **uv** (venv + lockfile management), **FastAPI + uvicorn** for the HTTP surface, **pytest + ruff + mypy** for tests/lint/types. Runtime deps include OpenCV-headless, numpy, Pillow, pillow-heif, sentry-sdk. The Worker side calls it via the typed adapter at `src/domain/dial-reader/` (`readDial(image, env)` returning a `DialReadResult` discriminated union — `success` / `rejection` / `malformed_image` / `transport_error`). Tests use a `__setTestDialReader` module-level override mirroring the existing `__setTestAiRunner` pattern. Container CI lives at `.github/workflows/python-ci.yml` and is path-filtered to `container/dial-reader/**`. Any change under that subtree must keep `cd container/dial-reader && uv run pytest && uv run ruff check . && uv run mypy src/` green; CI runs the same trio with `uv sync --frozen`. The legacy `src/domain/ai-dial-reader/` (Workers AI Llama vision) still exists alongside it and is removed in a later slice once the verified-reading flow has switched to the container path.

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
