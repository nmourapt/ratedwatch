# Infra + operator runbooks

This directory holds everything that lives outside of the Worker
script itself:

- `terraform/` — Terraform code that owns the D1 database, R2 bucket,
  KV namespace, and DNS / routes. See `terraform/README.md` for the
  IaC workflow.
- Operator-level runbooks (below) — manual SQL + `wrangler` commands
  used during phase-1 moderation before a real admin UI lands.

## Phase-1 movement moderation

Users can submit new movements when their watch's caliber isn't in the
curated list (issue #10). The submission lands with
`status = 'pending'` and `submitted_by_user_id` attached; the row is
visible to the submitter in the add-watch typeahead but excluded from
all public leaderboards and from other users' searches until it is
approved.

Approval is **manual SQL in phase 1** — no admin UI yet.

### Listing pending submissions

```bash
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler d1 execute rated-watch-db --remote --command \
  "SELECT id, canonical_name, manufacturer, caliber, type, submitted_by_user_id, created_at FROM movements WHERE status = 'pending' ORDER BY created_at DESC;"
```

Cross-reference the `submitted_by_user_id` against the `user` table if
you need to reach out to the submitter for more detail:

```bash
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler d1 execute rated-watch-db --remote --command \
  "SELECT id, email, username FROM user WHERE id = '<submitted_by_user_id>';"
```

### Approving a submission

```bash
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler d1 execute rated-watch-db --remote --command \
  "UPDATE movements SET status = 'approved' WHERE id = 'submitted-slug-here';"
```

After approval the movement shows up in the default typeahead for
every user and in leaderboard queries (once slice #14 ships the
aggregation).

### Rejecting a submission

No soft-reject flow in phase 1. If a submission is clearly spam or
duplicates an existing row with a different spelling, delete it:

```bash
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler d1 execute rated-watch-db --remote --command \
  "DELETE FROM movements WHERE id = 'submitted-slug-here';"
```

Watches still linked to the deleted movement will have their
`movement_id` set to `NULL` (ON DELETE SET NULL at the FK), so they
simply drop off the per-movement leaderboard until the owner re-attaches
them via the add/edit flow.

### Editing a pending submission before approval

If the submitter typed the wrong manufacturer or display name, it's OK
to fix it in place before flipping the status:

```bash
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler d1 execute rated-watch-db --remote --command \
  "UPDATE movements SET canonical_name = 'Seiko NH36A', manufacturer = 'Seiko', caliber = 'NH36A' WHERE id = 'seiko-nh36a' AND status = 'pending';"
```

Note the `id` is the generated slug (`<manufacturer>-<caliber>` kebab)
and changing `manufacturer`/`caliber` does **not** re-generate it — the
slug is locked in at submit time. If the slug itself is wrong, delete
the row and ask the submitter to re-submit with the corrected fields.

## Verified readings (slice #16)

Verified readings are AI-read watch-dial captures. The pipeline
(`src/domain/reading-verifier/verifier.ts`) stores the photo in R2 at
`readings/{readingId}/photo.jpg`. The DB row is canonical — it
records the signed deviation, reference timestamp, and `verified=1`
flag. The photo is kept for provenance only: if a leaderboard entry
is disputed, an operator can pull the photo and manually check the
AI read. Nothing in the runtime reads the photo back.

### Feature flag

The `POST /api/v1/watches/:id/readings/verified` endpoint is gated
behind the `ai_reading_v2` feature flag. It defaults to off
everywhere. To enable it for yourself (the operator) after a fresh
deploy:

```bash
npm run flags:set -- ai_reading_v2 '{"mode":"users","users":["<your-user-id>"]}'
```

To roll out gradually to a percentage of users:

```bash
npm run flags:set -- ai_reading_v2 '{"mode":"rollout","rolloutPct":10}'
```

### R2 retention — 90-day policy

Photos at `readings/{readingId}/photo.jpg` should age out after
**90 days**. Rationale: the photo is forensic provenance for the
deviation reading, not long-term archive; the reading itself is the
canonical record. 90 days gives moderators a generous window to
review disputed entries without the bucket growing unboundedly.

The policy is expressed as a Cloudflare Terraform
`cloudflare_r2_bucket_lifecycle_configuration` resource — see
`infra/terraform/r2.tf`. After `terraform apply`, verify with:

```bash
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler r2 bucket lifecycle list rated-watch-images
```

If the rule is missing (e.g. the IaC didn't apply), fall back to the
manual CLI:

```bash
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler r2 bucket lifecycle add rated-watch-images \
  --id expire-reading-photos \
  --prefix readings/ \
  --expire-days 90
```

### Checking a photo for a disputed reading

```bash
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler r2 object get \
  rated-watch-images/readings/<reading-id>/photo.jpg \
  --file /tmp/reading.jpg
open /tmp/reading.jpg
```
