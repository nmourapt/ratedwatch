# Production AI Gateway for the verified-reading VLM pipeline (PRD #99).
#
# All `env.AI.run(...)` calls in the production Worker route through
# this gateway via `{ gateway: { id: env.AI_GATEWAY_ID } }`, where
# `AI_GATEWAY_ID` is set to "ratedwatch-vlm" for the `production`
# wrangler environment (see wrangler.jsonc). Dev / preview / local
# deploys keep using the hand-created `dial-reader-bakeoff` gateway
# from PRD #99's bake-off — that gateway is intentionally NOT
# managed by Terraform (it's the operator's scratch sandbox).
#
# The gateway is required for unified-billing dispatch: the Worker's
# AI binding is pre-authenticated within the Cloudflare account, and
# the gateway injects the upstream provider credentials (OpenAI,
# Google, Anthropic) from Cloudflare's centrally-managed credit
# pool. Without `authentication = true` the gateway forwards the
# request without auth and the upstream returns "Missing or invalid
# Authorization header" — the bake-off discovered this the hard way,
# so DO NOT remove `authentication = true`.
#
# Settings rationale:
#   * `cache_invalidate_on_update = true` — verified readings are
#     temporally distinct (each photo is at a unique timestamp); a
#     stale cached response would silently corrupt the deviation
#     calculation. Combined with `cache_ttl = 0` this turns caching
#     off entirely.
#   * `cache_ttl = 0` — every verified-reading dispatch must hit the
#     model. Caching across photos is dangerous (different watches,
#     different times, identical-looking dials).
#   * `collect_logs = true` — operator visibility into prompt /
#     response pairs is required to triage misreads, evaluate prompt
#     tweaks, and feed the cheat-detection regression test.
#   * `rate_limiting_interval = 0` + `rate_limiting_limit = 0` —
#     gateway-side rate limiting is OFF; we rate-limit at the
#     Worker level (`VERIFIED_READING_LIMITER`, slice #4) where we
#     have per-user context.
#   * `authentication = true` — REQUIRED for unified-billing
#     dispatch. See bake-off note above.
#
# The `wholesale = true` flag (Cloudflare unified billing — every
# upstream call is billed against the gateway's credit pool rather
# than per-provider keys) is NOT exposed by the
# `cloudflare/cloudflare` provider at the version pinned in
# main.tf (5.19.0-beta.5). The schema lists `authentication`,
# `cache_*`, `rate_limiting_*`, `collect_logs`, `logpush*`,
# `retry_*`, `dlp`, `stripe`, `otel`, and `workers_ai_billing_mode`
# — but `wholesale` is absent. Operator MUST flip the flag manually
# after `terraform apply`:
#
#   curl -X PUT \
#     "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/gateways/ratedwatch-vlm" \
#     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
#     -H "Content-Type: application/json" \
#     --data '{
#       "id": "ratedwatch-vlm",
#       "cache_invalidate_on_update": true,
#       "cache_ttl": 0,
#       "collect_logs": true,
#       "rate_limiting_interval": 0,
#       "rate_limiting_limit": 0,
#       "authentication": true,
#       "wholesale": true
#     }'
#
# Verify after the flip:
#
#   curl -s \
#     "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/gateways/ratedwatch-vlm" \
#     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
#     | jq '.result | {authentication, wholesale, collect_logs}'
#
# Both `authentication` and `wholesale` must be `true`. Reasserting
# settings via Terraform (e.g. a future `terraform apply` after the
# manual flip) does NOT clobber `wholesale` because it's outside the
# provider's known attribute set — the API treats unspecified fields
# as no-op on PUT for AI Gateway. If a later provider release adds
# `wholesale` to the schema, set it here and drop this manual step.
#
# Credits and auto-top-up are NOT manageable via Terraform (the API
# does not expose them). Operator loads credits via the Cloudflare
# dashboard at https://dash.cloudflare.com/?to=/:account/ai/ai-gateway
# — see AGENTS.md ("AI Gateway operator runbook") for the full
# procedure including the recommended $50 initial budget and
# auto-top-up alert at $10 remaining.
resource "cloudflare_ai_gateway" "ratedwatch_vlm" {
  account_id                 = var.account_id
  id                         = "ratedwatch-vlm"
  cache_invalidate_on_update = true
  cache_ttl                  = 0
  collect_logs               = true
  rate_limiting_interval     = 0
  rate_limiting_limit        = 0
  authentication             = true
}

output "ai_gateway_id" {
  description = "Production AI Gateway slug. Set as AI_GATEWAY_ID for the production wrangler env."
  value       = cloudflare_ai_gateway.ratedwatch_vlm.id
}
