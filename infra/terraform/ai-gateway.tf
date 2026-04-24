# AI Gateway in front of Workers AI.
#
# All `env.AI.run(...)` calls in the Worker pass
# `{ gateway: { id: "ratedwatch" } }`, which routes inference through
# this gateway. That gives us request/response logs, rate limiting,
# and (later) cache + fallback policies without touching Worker code.
#
# Kept intentionally minimal for phase 1:
#   * `cache_ttl = 0` + `cache_invalidate_on_update = false` — we
#     explicitly don't want cache hits for dial reads. Every verified
#     reading must go to the model; a cache hit would silently return
#     the same second-hand position across photos.
#   * `collect_logs = true` — operator wants visibility into
#     prompt/response pairs for prompt-tuning the dial reader.
#   * `rate_limiting_interval = 60 / limit = 1000 / technique = fixed`
#     — defensive ceiling. Phase-1 traffic is a few requests per
#     second at peak; 1000 per minute leaves generous headroom while
#     still capping runaway bugs.
#
# The resource `id` ("ratedwatch") is the gateway *slug* — it appears
# verbatim in `env.AI.run(..., { gateway: { id: "ratedwatch" } })`,
# so keep this in sync with `AI_GATEWAY_ID` in
# src/domain/ai-dial-reader/runner.ts.
resource "cloudflare_ai_gateway" "ratedwatch" {
  account_id                 = var.account_id
  id                         = "ratedwatch"
  cache_invalidate_on_update = false
  cache_ttl                  = 0
  collect_logs               = true
  rate_limiting_interval     = 60
  rate_limiting_limit        = 1000
  rate_limiting_technique    = "fixed"
}

output "ai_gateway_id" {
  description = "AI Gateway slug used by the Worker in env.AI.run({ gateway: { id } })."
  value       = cloudflare_ai_gateway.ratedwatch.id
}
