# infra/terraform

Terraform module that manages the Cloudflare resources for rated.watch.

Everything here is declarative. All resource IDs needed by `wrangler.jsonc`
are exposed as outputs.

## Resources

| Resource | Terraform address                       | Name                 | Notes                                  |
| -------- | --------------------------------------- | -------------------- | -------------------------------------- |
| D1       | `cloudflare_d1_database.app`            | `rated-watch-db`     | Primary app database. WEUR.            |
| R2       | `cloudflare_r2_bucket.images`           | `rated-watch-images` | Watch photos. WEUR.                    |
| R2       | `cloudflare_r2_bucket.logs`             | `rated-watch-logs`   | Logpush destination (slice #19). WEUR. |
| KV       | `cloudflare_workers_kv_namespace.flags` | `rated-watch-flags`  | Feature flags (slice #20).             |

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
