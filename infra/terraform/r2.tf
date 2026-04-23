# R2 buckets for the application.
#
# Note: the `ratedwatch-tfstate` bucket (used by the Terraform backend itself)
# is NOT declared here — it is bootstrapped by scripts/bootstrap.sh before
# Terraform can initialise, and Terraform does not manage it (chicken and egg).

# User-uploaded watch photos. Served back via the Worker; private by default,
# made public via signed URLs / per-watch visibility toggle (slice #11).
resource "cloudflare_r2_bucket" "images" {
  account_id = var.account_id
  name       = "rated-watch-images"
  location   = upper(var.location_hint)
}

# Logpush destination. Populated by slice #19 (observability).
resource "cloudflare_r2_bucket" "logs" {
  account_id = var.account_id
  name       = "rated-watch-logs"
  location   = upper(var.location_hint)
}
