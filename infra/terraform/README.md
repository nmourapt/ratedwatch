# infra/terraform

Terraform module that manages the Cloudflare resources for rated.watch.

Everything here is declarative. All resource IDs needed by `wrangler.jsonc`
are exposed as outputs.

## Resources

| Resource | Terraform address                             | Name                          | Notes                                                                      |
| -------- | --------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| D1       | `cloudflare_d1_database.app`                  | `rated-watch-db`              | Primary app database. WEUR.                                                |
| R2       | `cloudflare_r2_bucket.images`                 | `rated-watch-images`          | Watch photos. WEUR.                                                        |
| R2       | `cloudflare_r2_bucket.logs`                   | `rated-watch-logs`            | Logpush destination (slice #19). WEUR.                                     |
| KV       | `cloudflare_workers_kv_namespace.flags`       | `rated-watch-flags`           | Feature flags (slice #20).                                                 |
| Logpush  | `cloudflare_logpush_job.workers_trace_events` | `ratedwatch-workers-trace-r2` | Workers Logs → R2, day-partitioned. Slice #19. Needs R2 token (see below). |

`ratedwatch-tfstate` is the R2 bucket that stores the Terraform state itself.
It is **not** declared here — see [Bootstrap](#bootstrap) for why.

## Prerequisites

- `terraform >= 1.6`
- `aws` CLI (only if you want to inspect state directly)
- `curl`, `jq`, `python3` (only for [`scripts/bootstrap.sh`](scripts/bootstrap.sh))
- Cloudflare account ownership of the rated.watch zone

## Bootstrap

One-time, to get from zero to a working `terraform apply`:

1. **Mint a bootstrap token in the Cloudflare dashboard.**
   My Profile → API Tokens → Create Token → use the **Create Additional Tokens**
   template. Scope it to the Babybites account with `Account API Tokens: Edit`.
   This is the only permission it needs — it will mint more granular tokens.
2. **Save it to `.env` as `CLOUDFLARE_BOOTSTRAP_TOKEN`** (file is gitignored).
3. **Ensure `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_ZONE_ID_RATED_WATCH` are set in `.env`.**
4. **Run the bootstrap script.** It mints the scoped `CLOUDFLARE_API_TOKEN`,
   creates the `ratedwatch-tfstate` R2 bucket, and prints the env var lines
   you need to append to `.env`:

   ```bash
   set -a && source .env && set +a
   ./infra/terraform/scripts/bootstrap.sh >> .env
   ```

5. **Initialise Terraform.** Loads the `.env` into the shell and pulls the
   backend + provider:

   ```bash
   set -a && source .env && set +a
   terraform -chdir=infra/terraform init
   ```

6. **Plan and apply.** Free-tier resources only.

   ```bash
   terraform -chdir=infra/terraform plan -out=tfplan
   terraform -chdir=infra/terraform apply tfplan
   ```

7. **Rotate the bootstrap token.** Once the scoped token is in place, revoke
   the bootstrap token in the dashboard. You can keep its metadata in `.env`
   with an empty value if you want to document the provenance chain.

## Why is the tfstate bucket not in Terraform?

Chicken and egg: Terraform needs the R2 bucket to exist before it can
initialise its backend, so the bucket cannot be declared as a resource
in the same configuration that uses it. The bootstrap script creates the
bucket imperatively, once; after that, Terraform manages everything else
in that bucket's state file.

## Day-to-day workflow

After the one-time bootstrap, a normal change cycle is:

```bash
set -a && source .env && set +a

# Edit *.tf

terraform -chdir=infra/terraform fmt
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform plan -out=tfplan
terraform -chdir=infra/terraform apply tfplan

# Copy any new IDs out of `terraform output -json` into wrangler.jsonc.
npm run types:gen     # regenerate worker-configuration.d.ts
npm run typecheck
npm run test
```

## Rotating tokens

| Token                                         | How to rotate                                                                                                                                                                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_BOOTSTRAP_TOKEN`                  | Revoke in dashboard, mint a new one with the same scope, update `.env`. No impact on running services.                                                                                                                                       |
| `CLOUDFLARE_API_TOKEN` (ratedwatch-terraform) | Re-run `bootstrap.sh` with a current bootstrap token; append the new lines to `.env` (overwrites `CLOUDFLARE_API_TOKEN` and the derived `AWS_*`). Then revoke the previous ratedwatch-terraform token via `DELETE /accounts/:id/tokens/:id`. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | These are derived from `CLOUDFLARE_API_TOKEN` — rotating the token rotates these automatically.                                                                                                                                              |

## Observability (slice #19)

The Worker emits product events to Analytics Engine (`rw_events`
dataset, bound as `ANALYTICS` in `wrangler.jsonc`) and Workers Logs
(`observability.enabled = true`). Workers Logs is additionally pushed
into R2 via `cloudflare_logpush_job.workers_trace_events`.

### Provisioning the Logpush job

The job depends on an R2 API token. Cloudflare's Terraform provider
can create R2 buckets but **not** R2 tokens (those are minted via the
dashboard or a separate API call); we therefore treat the token as an
out-of-band operator secret.

**Option A — mint programmatically** (when a `CLOUDFLARE_BOOTSTRAP_TOKEN` is live; this is how the current token was minted):

```bash
set -a && source .env && set +a
RESOURCE="com.cloudflare.edge.r2.bucket.${CLOUDFLARE_ACCOUNT_ID}_default_rated-watch-logs"
curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/tokens" \
  -H "Authorization: Bearer ${CLOUDFLARE_BOOTSTRAP_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"ratedwatch-logpush-r2\",\"policies\":[{\"effect\":\"allow\",\"resources\":{\"${RESOURCE}\":\"*\"},\"permission_groups\":[{\"id\":\"2efd5506f9c8494dacb1fa10a3e7d5b6\"}]}]}"
# Derive S3 creds: Access Key ID = token.id, Secret = sha256(token.value)
```

**Option B — mint via dashboard** (fallback when the bootstrap token has already been revoked):

1. Cloudflare dashboard → **R2** → **Manage R2 API Tokens** → **Create API token**.
2. Scope: **Object Read & Write**, limited to the `rated-watch-logs` bucket. All other permissions off.
3. Copy the **Access Key ID** and **Secret Access Key**.

**Either way — apply the Terraform**:

```bash
set -a && source .env && set +a
export TF_VAR_logpush_r2_access_key_id="…"
export TF_VAR_logpush_r2_secret_access_key="…"
terraform -chdir=infra/terraform plan -out=tfplan
terraform -chdir=infra/terraform apply tfplan
```

> Tip: the TF token (`CLOUDFLARE_API_TOKEN`) must include **"Logs Write"** at the account level to create the Logpush job itself. `bootstrap.sh` mints it with this perm; older TF tokens can't create the job (403). Re-run `bootstrap.sh` if you're rotating.

Post-apply, verify by triggering any request against the Worker and
waiting ~30 seconds; a `logs/YYYY-MM-DD/…ndjson.gz` object should
appear in the `rated-watch-logs` R2 bucket.

### Sentry

Live via `@sentry/cloudflare`. Two integration points:

- `src/observability/sentry.ts` exports `withSentry(handler)` (used
  to wrap the Worker's default export in `src/worker/index.tsx`) and
  `captureException(err, ctx)` (callable at any callsite for
  intentional reports).
- `SENTRY_DSN` Worker secret drives init. Set once via
  `wrangler secret put SENTRY_DSN`. When the secret is absent
  (local dev, CI without the secret set) `withSentry` degrades to a
  passthrough and `captureException` falls back to console.error
  with a `sentry-stub:` log prefix — the unified interface stays
  stable so callsites never branch.
- Environment label `production`, `tracesSampleRate: 0.1`,
  `sendDefaultPii: false`. Tune in `src/observability/sentry.ts`
  if the free-tier event cap tightens.
- Smoke-test the integration after any secret rotation by
  temporarily adding `throw new Error("sentry smoke")` to a route,
  hitting it, and confirming the event in the Sentry dashboard.

## Followups (tracked elsewhere)

- **Scoped tokens for Wrangler and CI** — currently CI does not deploy the
  Worker; when it does (slice #19/#21), TF will mint dedicated
  `wrangler-deploy` and `ci-deploy` tokens and surface them as outputs for
  GitHub Actions secrets.
- **Custom domain cutover** — slice #21 flips `rated.watch/*` to the Worker
  via `cloudflare_workers_custom_domain` and deprecates the
  `*.workers.dev` hostname.
- **D1 migrations** — Kysely schema lands in a slice that needs persistence;
  migrations will live in `migrations/` and be applied via
  `wrangler d1 migrations apply`.
