# Wildcard subdomain routing for rated.watch.
#
# The apex rated.watch → ratedwatch Worker is handled by the Custom
# Domain resource in workers-domain.tf. Subdomains (www.rated.watch,
# api.rated.watch, etc.) need a different mechanism because Custom
# Domains only accept an exact hostname, not a wildcard. Workers
# Routes do accept wildcards — at the cost of losing the
# Custom-Domain niceties (auto-managed TLS cert, implicit same-zone
# fetch, etc.), which is an acceptable trade for catch-all subdomain
# coverage.
#
# The DNS record below is a proxied A record at *.rated.watch
# pointing at TEST-NET-1 (192.0.2.1 — RFC 5737 non-routable). The
# content is irrelevant; Cloudflare's proxy layer short-circuits the
# request and hands it to the Workers Route instead. This is a
# standard "orange-cloud wildcard" pattern.

resource "cloudflare_dns_record" "wildcard_subdomain" {
  zone_id = var.zone_id
  name    = "*.rated.watch"
  type    = "A"
  content = "192.0.2.1" # TEST-NET-1, RFC 5737 non-routable placeholder
  proxied = true
  ttl     = 1 # "auto" — required when proxied is true
  comment = "Proxy-only placeholder; traffic routed by workers_route.wildcard_subdomain below"
}

resource "cloudflare_workers_route" "wildcard_subdomain" {
  zone_id = var.zone_id
  pattern = "*.rated.watch/*"
  script  = var.worker_name
}

output "subdomain_wildcard_pattern" {
  description = "Wildcard route pattern — any subdomain of rated.watch hits the Worker."
  value       = cloudflare_workers_route.wildcard_subdomain.pattern
}
