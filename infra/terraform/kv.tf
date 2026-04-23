# KV namespace for feature flags. Consumed by the `isEnabled(flag, ctx)`
# service from slice #20. Separate KV namespace for each concern keeps blast
# radius small if we ever expose read access from a scoped sub-token.
resource "cloudflare_workers_kv_namespace" "flags" {
  account_id = var.account_id
  title      = "rated-watch-flags"
}
