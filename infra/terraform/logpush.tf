# Logpush job → R2 (slice #19 — observability).
#
# Streams `workers_trace_events` (console.log + request metadata
# captured by Workers Logs) into the `rated-watch-logs` R2 bucket so
# we retain structured logs beyond Cloudflare's default 3-day Workers
# Logs retention window.
#
# ---- Operator preconditions ---------------------------------------
#
# Before the first `terraform apply` of this resource:
#
#   1. Mint an R2 API token scoped to `rated-watch-logs` with
#      "Object Read & Write" permissions. Cloudflare dashboard:
#      R2 → Manage R2 API Tokens → Create API token → scope to the
#      specific bucket.
#   2. Set `TF_VAR_logpush_r2_access_key_id` and
#      `TF_VAR_logpush_r2_secret_access_key` in your shell env (or
#      `.env` — the repo's shell workflow sources it before terraform
#      commands). These feed the variables below; the secret is marked
#      `sensitive` so it never prints to stdout or the plan output.
#
# Leaving those vars unset makes `terraform plan` fail with a clear
# "variable has no value" error rather than silently creating an
# unauthenticated job.
#
# ---- Destination URL shape ----------------------------------------
#
# Cloudflare's Logpush → R2 integration uses the native `r2://` scheme
# (not the generic S3-compatible form). Path partitioning is
# controlled by `{DATE}` expansion — one file per day under
# `logs/YYYY-MM-DD/` inside the bucket. This keeps downstream readers
# (the Babybites-internal observability tooling, ad-hoc `aws s3 sync`
# pulls) trivially navigable.
#
# ---- Fields ---------------------------------------------------------
#
# The Workers Logs schema is the `workers_trace_events` dataset. We
# ship the minimum useful field set:
#
#   * Event / EventTimestampMs — log envelope.
#   * Outcome                  — ok | exception | exceededCpu | …
#   * Exceptions               — thrown error details.
#   * Logs                     — console.* output per request.
#   * ScriptName / ScriptVersion — deploy attribution.
#
# Growing this list is cheap; shrinking it later is cheap too.

variable "logpush_r2_access_key_id" {
  description = "R2 API token Access Key ID, scoped to the rated-watch-logs bucket. Set via TF_VAR_logpush_r2_access_key_id."
  type        = string
  sensitive   = true
}

variable "logpush_r2_secret_access_key" {
  description = "R2 API token Secret Access Key, scoped to the rated-watch-logs bucket. Set via TF_VAR_logpush_r2_secret_access_key."
  type        = string
  sensitive   = true
}

resource "cloudflare_logpush_job" "workers_trace_events" {
  account_id       = var.account_id
  name             = "ratedwatch-workers-trace-r2"
  dataset          = "workers_trace_events"
  enabled          = true
  destination_conf = "r2://${cloudflare_r2_bucket.logs.name}/logs/{DATE}?account-id=${var.account_id}&access-key-id=${var.logpush_r2_access_key_id}&secret-access-key=${var.logpush_r2_secret_access_key}"

  output_options = {
    output_type      = "ndjson"
    timestamp_format = "rfc3339"
    field_names = [
      "Event",
      "EventTimestampMs",
      "Outcome",
      "Exceptions",
      "Logs",
      "ScriptName",
      "ScriptVersion",
    ]
  }

  # Upload pacing. Cloudflare batches then ships; these are upper
  # bounds on size / interval. A 30-second interval puts "first log
  # object visible" well under the ~5-min acceptance bar in the PRD.
  max_upload_bytes            = 10 * 1024 * 1024 # 10 MB
  max_upload_interval_seconds = 30
}
