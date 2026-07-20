# HERALD agent stack — gia (lambda, growth/engagement). State: herald/gia-prod.tfstate.
# Gia proposes warm-only engagement + company-page drafts; Vera clears them; the
# browser executor acts. Self-contained (SEC-3 / SPEC-H 4): the ONLY outbound edge
# is Vera (review_content). Lambda variant, mirroring herald-nico — engage +
# enqueue_follow are deterministic; manage_company_page spends model tokens through
# the same engine-wide $400 gate. No browser, no session vault: Gia never publishes
# or engages directly (a cleared engagement is executed by Piper-family downstream).
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
  backend "s3" {
    bucket         = "cios-tfstate-262602454064"
    key            = "herald/gia-prod.tfstate"
    region         = "us-east-1"
    dynamodb_table = "cios-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = { project = "cios", service = "herald-gia", engine = "herald", managed_by = "terraform" }
  }
}

variable "zip_path" {
  type    = string
  default = "../../../agents/herald-gia/dist/function.zip"
}

module "agent" {
  source = "../../modules/agent-service"

  agent    = "gia"
  env      = "prod"
  variant  = "lambda"
  zip_path = var.zip_path

  # Comment copy + company-page drafts go to Vera — the only edge Gia holds (SPEC-H 4).
  invoke_peers = ["vera"]
}

output "service_name" {
  value = module.agent.service_name
}
output "function_url" {
  value = module.agent.function_url
}
output "scheduler_role_arn" {
  value = module.agent.scheduler_role_arn
}
output "secret_arns" {
  value = module.agent.secret_arns
}
output "invoke_policy_arn" {
  value = module.agent.invoke_policy_arn
}
