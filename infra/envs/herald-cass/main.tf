# HERALD agent stack — cass (lambda, calendar). State: herald/cass-prod.tfstate.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
  backend "s3" {
    bucket         = "cios-tfstate-262602454064"
    key            = "herald/cass-prod.tfstate"
    region         = "us-east-1"
    dynamodb_table = "cios-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = { project = "cios", service = "herald-cass", engine = "herald", managed_by = "terraform" }
  }
}

variable "zip_path" {
  type    = string
  default = "../../../agents/herald-cass/dist/function.zip"
}

module "agent" {
  source = "../../modules/agent-service"

  agent    = "cass"
  env      = "prod"
  variant  = "lambda"
  zip_path = var.zip_path

  # Calendar slot to draft — cass may only hand off to Nico (SPEC-H section 4).
  invoke_peers = ["nico"]
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
