variable "account_id" {
  description = "Cloudflare account ID that owns the rated.watch zone (Babybites)."
  type        = string
  default     = "d94d0ebef658cbd92166d633c8f065c9"
}

variable "zone_id" {
  description = "Zone ID for rated.watch. Used by DNS / Workers Route resources in later slices."
  type        = string
  default     = "41a9c69cf1fb3589b93ed1c989881e7a"
}

variable "worker_name" {
  description = "Name of the Worker script. Matches wrangler.jsonc."
  type        = string
  default     = "ratedwatch"
}

variable "location_hint" {
  description = "Preferred location hint for resources that support it. WEUR matches the primary user base."
  type        = string
  default     = "weur"
}
