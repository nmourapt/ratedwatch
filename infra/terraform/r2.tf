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
    },
    # Slice #6 of PRD #99 (issue #105): the verified-reading two-step
    # API split. `POST /readings/verified/draft` writes the photo to
    # `drafts/{user_id}/{uuid}.jpg` and returns a signed reading_token
    # with a 5-minute lifetime. `POST /readings/verified/confirm`
    # moves the photo to `verified/{user_id}/{reading_id}.jpg` on
    # success.
    #
    # Drafts that the user never confirms (closed the tab, network
    # blip after the upload, etc.) accumulate at this prefix.
    # Lifecycle expires them after 24h: well past the 5-minute token
    # window so we don't compete with a slow user, and short enough
    # that the prefix doesn't grow unboundedly.
    #
    # 60 * 60 * 24 = 24 hours.
    {
      id      = "expire-draft-photos"
      enabled = true

      conditions = {
        prefix = "drafts/"
      }

      delete_objects_transition = {
        condition = {
          type    = "Age"
          max_age = 60 * 60 * 24
        }
      }

      # Multipart uploads to draft photos almost never happen — the
      # SPA pre-resizes and POSTs as a single-part body — but if a
      # client somehow starts a multipart and abandons it, we don't
      # want orphaned parts hanging around. 1 day matches the
      # main-object expiry.
      abort_multipart_uploads_transition = {
        condition = {
          type    = "Age"
          max_age = 60 * 60 * 24
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

# Training-corpus bucket — slice #81 of PRD #73.
#
# Receives photos + anonymized JSON sidecars whenever a verified-
# reading attempt either rejects or succeeds with low-margin
# confidence (< 0.85), provided the user opted in via
# `consent_corpus = 1`. The bucket is operator-private; nothing on
# the public surface ever serves bytes back from here.
#
# Object layout:
#   corpus/{YYYY-MM-DD}/{reading_id}/photo.{ext}
#   corpus/{YYYY-MM-DD}/{reading_id}/sidecar.json
#
# No user_id, no watch_id, no PII timestamps in keys or sidecars —
# the corpus module's `maybeIngest` enforces this by not accepting
# user/watch identifiers. Retroactive deletion (consent toggle
# 1→0) is handled by the Worker enumerating that user's reading
# IDs and deleting `corpus/*/{readingId}/*` from this bucket.
#
# No lifecycle policy: training corpus value compounds over time
# and a few GB of historical photos is cheaper than re-collecting
# them.
resource "cloudflare_r2_bucket" "corpus" {
  account_id = var.account_id
  name       = "rated-watch-corpus"
  location   = upper(var.location_hint)
}
