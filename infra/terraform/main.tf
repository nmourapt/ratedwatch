terraform {
  required_version = ">= 1.6"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.8.0, < 6.0.0"
    }
  }

  # State lives in the Babybites-owned R2 bucket `ratedwatch-tfstate`.
  # Credentials come from the AWS_* env vars set in .env (sourced before
  # `terraform init`). The bucket and the S3-compatible credentials are
  # created by scripts/bootstrap.sh before this backend can initialise.
  backend "s3" {
    bucket = "ratedwatch-tfstate"
    key    = "terraform.tfstate"
    region = "auto"

    # R2 has no regions, no checksum algorithms, and no AWS-specific
    # infrastructure to probe. These skip_* flags disable validation
    # that would otherwise fail against R2.
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = false

    # AWS_ENDPOINT_URL_S3 is read from env.
  }
}

# Cloudflare provider. Reads CLOUDFLARE_API_TOKEN from env.
provider "cloudflare" {}
