# Workers Custom Domain — rated.watch apex → ratedwatch Worker.
#
# This is the slice #21 cutover: users typing `rated.watch` now hit the
# deployed Worker directly rather than falling through to the placeholder
# A record that used to live here (pointing at 1.2.3.4). Cloudflare
# manages the DNS record and the edge TLS certificate automatically
# when this resource is created — the prior manual A records on the
# apex and the wildcard were removed out-of-band before the first apply.
#
# The Worker also stays accessible on `ratedwatch.nmoura.workers.dev`
# because `workers_dev: true` is implicitly on in wrangler.jsonc. A
# future cleanup slice can disable that once rated.watch is the
# canonical URL everywhere (SEO / analytics reasons).
#
# `www.rated.watch` is NOT managed here — phase 1 is apex-only. Add a
# second resource + a DNS A record (or CNAME flattening) if a www
# redirect becomes necessary.

resource "cloudflare_workers_custom_domain" "apex" {
  account_id  = var.account_id
  zone_id     = var.zone_id
  hostname    = "rated.watch"
  service     = var.worker_name
  environment = "production"
}

output "custom_domain_hostname" {
  description = "Canonical hostname for the ratedwatch Worker after cutover."
  value       = cloudflare_workers_custom_domain.apex.hostname
}
