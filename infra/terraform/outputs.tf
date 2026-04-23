# Outputs used to wire wrangler.jsonc bindings. After `terraform apply`,
# run `terraform output -json` to copy the IDs into wrangler.jsonc.
#
# Bucket names are the identifier wrangler uses (not an ID), so they are
# included as `name`. Everything else is an opaque ID.

output "d1_database_id" {
  description = "D1 database ID for the rated-watch-db binding (wrangler `d1_databases[].database_id`)."
  value       = cloudflare_d1_database.app.id
}

output "d1_database_name" {
  description = "D1 database name (wrangler `d1_databases[].database_name`)."
  value       = cloudflare_d1_database.app.name
}

output "r2_images_bucket_name" {
  description = "R2 bucket name for watch images (wrangler `r2_buckets[].bucket_name`)."
  value       = cloudflare_r2_bucket.images.name
}

output "r2_logs_bucket_name" {
  description = "R2 bucket name for Logpush destination (wrangler `r2_buckets[].bucket_name`)."
  value       = cloudflare_r2_bucket.logs.name
}

output "kv_flags_namespace_id" {
  description = "KV namespace ID for feature flags (wrangler `kv_namespaces[].id`)."
  value       = cloudflare_workers_kv_namespace.flags.id
}

# The Worker is deployed to *.workers.dev via wrangler's default
# `workers_dev: true`. The custom-domain cutover lives in slice #22
# (Terraform flips rated.watch/* to the deployed Worker script).
output "workers_dev_hostname" {
  description = "Current Worker hostname (managed by wrangler deploy, not Terraform)."
  value       = "${var.worker_name}.nmoura.workers.dev"
}
