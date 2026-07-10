# HERALD agent stack — rhea (lambda, presence reporter). State: herald/rhea-prod.tfstate.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
  backend "s3" {
    bucket         = "cios-tfstate-262602454064"
    key            = "herald/rhea-prod.tfstate"
    region         = "us-east-1"
    dynamodb_table = "cios-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = { project = "cios", service = "herald-rhea", engine = "herald", managed_by = "terraform" }
  }
}

variable "zip_path" {
  type    = string
  default = "../../../agents/herald-rhea/dist/function.zip"
}

module "agent" {
  source = "../../modules/agent-service"

  agent    = "rhea"
  env      = "prod"
  variant  = "lambda"
  zip_path = var.zip_path

  # Rhea reads leadcrm-prod (deal reporter) — extra leadcrm-key placeholder (SPEC-B 2.1).
  secret_keys = ["anthropic-key", "cf-service-key", "cf-anon-key", "leadcrm-key"]

  # Report claims check routes through Vera (SPEC-H section 4).
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
