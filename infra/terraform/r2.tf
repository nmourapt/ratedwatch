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

# Lifecycle policy for verified-reading photos (slice #16).
#
# Photos at `readings/{reading-id}/photo.jpg` are forensic provenance
# for AI-read deviations — they're never served back to users and are
# only touched when a moderator disputes a reading. 90 days gives us
# a generous review window without the bucket growing unboundedly.
#
# The reading row (in D1) is the canonical record of the deviation;
# losing the photo after expiry does NOT invalidate the reading.
resource "cloudflare_r2_bucket_lifecycle" "images" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.images.name

  rules = [
    {
      id      = "expire-reading-photos"
      enabled = true

      conditions = {
        prefix = "readings/"
      }

      # `max_age` is expressed in seconds per the Cloudflare R2 API.
      # 60 * 60 * 24 * 90 = 90 days.
      delete_objects_transition = {
        condition = {
          type    = "Age"
          max_age = 60 * 60 * 24 * 90
        }
      }
    }
  ]
}

# Logpush destination. Populated by slice #19 (observability).
resource "cloudflare_r2_bucket" "logs" {
  account_id = var.account_id
  name       = "rated-watch-logs"
  location   = upper(var.location_hint)
}
