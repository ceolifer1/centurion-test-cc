# HERALD agent stack — nico (lambda, content drafter). State: herald/nico-prod.tfstate.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
  backend "s3" {
    bucket         = "cios-tfstate-262602454064"
    key            = "herald/nico-prod.tfstate"
    region         = "us-east-1"
    dynamodb_table = "cios-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = { project = "cios", service = "herald-nico", engine = "herald", managed_by = "terraform" }
  }
}

variable "zip_path" {
  type    = string
  default = "../../../agents/herald-nico/dist/function.zip"
}

module "agent" {
  source = "../../modules/agent-service"

  agent    = "nico"
  env      = "prod"
  variant  = "lambda"
  zip_path = var.zip_path

  # Drafts go to Vera for review — the only edge Nico holds (SPEC-H section 4).
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
