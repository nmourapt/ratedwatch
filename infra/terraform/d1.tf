# Primary D1 database for the application. Used by the Kysely data layer
# (src/db/) once slices that need persistence land.
resource "cloudflare_d1_database" "app" {
  account_id            = var.account_id
  name                  = "rated-watch-db"
  primary_location_hint = var.location_hint
}
