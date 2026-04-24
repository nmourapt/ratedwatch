#!/usr/bin/env bash
# wrangler-types-clean.sh — regenerate worker-configuration.d.ts with the
# same view of the environment that CI sees.
#
# Why: `wrangler types` always loads `.dev.vars` and emits its keys as
# additional Env fields (e.g. BETTER_AUTH_SECRET when you have a local
# dev secret). CI doesn't have `.dev.vars`, so a types:check comparison
# of the committed file vs a CI-regenerated one fails.
#
# CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false only disables `.env`
# loading, not `.dev.vars`. Until wrangler exposes a direct flag to
# skip `.dev.vars`, we move it out of the way for the duration of the
# run.
#
# Idempotent. Safe to cancel mid-run — the trap restores .dev.vars.

set -euo pipefail

BACKUP=".dev.vars.types-gen.bak"
RESTORE_NEEDED=0

if [ -f .dev.vars ]; then
  mv .dev.vars "$BACKUP"
  RESTORE_NEEDED=1
  trap 'mv "$BACKUP" .dev.vars' EXIT
fi

CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler types "$@"
