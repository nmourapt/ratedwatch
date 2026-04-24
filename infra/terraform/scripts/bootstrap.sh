#!/usr/bin/env bash
# Bootstraps the Terraform setup for rated.watch.
#
# Runs exactly three Cloudflare API operations:
#
#   1. Mint a scoped CLOUDFLARE_API_TOKEN (the "ratedwatch-terraform" token)
#      using the broader CLOUDFLARE_BOOTSTRAP_TOKEN.
#   2. Create the R2 bucket `ratedwatch-tfstate` that holds Terraform state.
#   3. Derive S3-compatible credentials from the scoped token per
#      https://developers.cloudflare.com/r2/api/tokens/ (AccessKeyId = token
#      id, SecretAccessKey = sha256 of token value).
#
# The output is a set of export lines you append to ratedwatch/.env. The
# script itself does NOT write to .env — keeps secret handling explicit.
#
# Idempotency: the R2 bucket creation is idempotent (Cloudflare returns the
# existing bucket). Token minting is NOT idempotent — re-running creates a
# new token. If you re-run, revoke the previous ratedwatch-terraform token
# via the Cloudflare dashboard or `DELETE /accounts/:id/tokens/:id`.
#
# Requirements:
#   - curl, jq, python3 (for sha256)
#   - CLOUDFLARE_BOOTSTRAP_TOKEN, CLOUDFLARE_ACCOUNT_ID,
#     CLOUDFLARE_ZONE_ID_RATED_WATCH set in the environment (source .env first)
#
# Rotation procedure (once scoped token is in place):
#   1. Revoke the bootstrap token in the Cloudflare dashboard.
#   2. Mint a new bootstrap token (User My Profile > API Tokens > Create Token
#      > "Create Additional Tokens" template, Account API Tokens:Edit scoped
#      to the Babybites account).
#   3. Save the new value as CLOUDFLARE_BOOTSTRAP_TOKEN in .env.
#   4. If you also want to rotate CLOUDFLARE_API_TOKEN, re-run this script.

set -euo pipefail

: "${CLOUDFLARE_BOOTSTRAP_TOKEN:?set CLOUDFLARE_BOOTSTRAP_TOKEN in .env}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID in .env}"
: "${CLOUDFLARE_ZONE_ID_RATED_WATCH:?set CLOUDFLARE_ZONE_ID_RATED_WATCH in .env}"

CF_API="https://api.cloudflare.com/client/v4"
AUTH_BOOT=(-H "Authorization: Bearer ${CLOUDFLARE_BOOTSTRAP_TOKEN}")

log() { printf '\033[36m==>\033[0m %s\n' "$*" >&2; }
err() { printf '\033[31m!!\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. Look up permission group IDs we need ----------------------------------
log "Fetching account permission groups..."
pg_json=$(curl -sS "${CF_API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/tokens/permission_groups" "${AUTH_BOOT[@]}")
if [[ "$(echo "$pg_json" | jq -r '.success')" != "true" ]]; then
  err "permission_groups fetch failed: $(echo "$pg_json" | jq -c '.errors')"
fi

# Use `jq` to resolve names to IDs. Names are the canonical stable identifier
# for us; Cloudflare warns the display name is cosmetic, but IDs rotate across
# environments so lookup by name is the least-brittle for a shell script.
pg_id() {
  local name="$1"
  local id
  id=$(echo "$pg_json" | jq -r --arg n "$name" '.result[] | select(.name == $n) | .id')
  [[ -n "$id" && "$id" != "null" ]] || err "permission group not found: $name"
  echo "$id"
}

PG_D1_WRITE=$(pg_id "D1 Write")
PG_R2_WRITE=$(pg_id "Workers R2 Storage Write")
PG_KV_WRITE=$(pg_id "Workers KV Storage Write")
PG_WORKERS_SCRIPTS=$(pg_id "Workers Scripts Write")
PG_WORKERS_TAIL=$(pg_id "Workers Tail Read")
PG_ACCOUNT_SETTINGS=$(pg_id "Account Settings Read")
PG_LOGS_WRITE=$(pg_id "Logs Write")
PG_DNS_WRITE=$(pg_id "DNS Write")
PG_ZONE_READ=$(pg_id "Zone Read")
PG_WORKERS_ROUTES=$(pg_id "Workers Routes Write")

# --- 2. Mint the ratedwatch-terraform token -----------------------------------
log "Minting ratedwatch-terraform token..."
token_payload=$(jq -n \
  --arg acct "com.cloudflare.api.account.${CLOUDFLARE_ACCOUNT_ID}" \
  --arg zone "com.cloudflare.api.account.zone.${CLOUDFLARE_ZONE_ID_RATED_WATCH}" \
  --arg d1 "$PG_D1_WRITE" \
  --arg r2 "$PG_R2_WRITE" \
  --arg kv "$PG_KV_WRITE" \
  --arg ws "$PG_WORKERS_SCRIPTS" \
  --arg wt "$PG_WORKERS_TAIL" \
  --arg as "$PG_ACCOUNT_SETTINGS" \
  --arg lw "$PG_LOGS_WRITE" \
  --arg dns "$PG_DNS_WRITE" \
  --arg zr "$PG_ZONE_READ" \
  --arg wr "$PG_WORKERS_ROUTES" \
  '{
     name: "ratedwatch-terraform",
     policies: [
       {
         effect: "allow",
         resources: { ($acct): "*" },
         permission_groups: [
           { id: $d1 }, { id: $r2 }, { id: $kv },
           { id: $ws }, { id: $wt }, { id: $as },
           { id: $lw }
         ]
       },
       {
         effect: "allow",
         resources: { ($zone): "*" },
         permission_groups: [
           { id: $dns }, { id: $zr }, { id: $wr }
         ]
       }
     ]
   }')

mint_json=$(curl -sS -X POST "${CF_API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/tokens" \
  "${AUTH_BOOT[@]}" \
  -H "Content-Type: application/json" \
  --data "$token_payload")

if [[ "$(echo "$mint_json" | jq -r '.success')" != "true" ]]; then
  err "token mint failed: $(echo "$mint_json" | jq -c '.errors')"
fi

TF_TOKEN=$(echo "$mint_json" | jq -r '.result.value')
TF_TOKEN_ID=$(echo "$mint_json" | jq -r '.result.id')
log "Minted token id=${TF_TOKEN_ID}"

# --- 3. Create the R2 tfstate bucket (idempotent) -----------------------------
AUTH_TF=(-H "Authorization: Bearer ${TF_TOKEN}")
log "Creating R2 bucket ratedwatch-tfstate (WEUR)..."
bucket_json=$(curl -sS -X POST "${CF_API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets" \
  "${AUTH_TF[@]}" \
  -H "Content-Type: application/json" \
  --data '{"name":"ratedwatch-tfstate","locationHint":"weur"}')

# "10006" is the Cloudflare error code for "bucket already exists" — idempotent no-op.
if [[ "$(echo "$bucket_json" | jq -r '.success')" != "true" ]]; then
  if echo "$bucket_json" | jq -e '.errors[] | select(.code == 10006)' >/dev/null; then
    log "  bucket already exists; skipping"
  else
    err "bucket create failed: $(echo "$bucket_json" | jq -c '.errors')"
  fi
fi

# --- 4. Derive S3-compatible credentials --------------------------------------
AWS_ACCESS_KEY_ID="$TF_TOKEN_ID"
AWS_SECRET_ACCESS_KEY=$(printf '%s' "$TF_TOKEN" | python3 -c 'import sys,hashlib; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')
AWS_ENDPOINT_URL_S3="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"

# --- 5. Print export lines for the user to paste into .env --------------------
cat <<ENV

# -------- append the lines below into ratedwatch/.env --------
CLOUDFLARE_API_TOKEN=${TF_TOKEN}
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
AWS_ENDPOINT_URL_S3=${AWS_ENDPOINT_URL_S3}
AWS_REGION=auto
# -------------------------------------------------------------
ENV
