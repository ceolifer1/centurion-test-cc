# HERALD agent stack — sol (lambda, SEO/SERP — API half). State: herald/sol-prod.tfstate.
# Sol's browser half rides the shared herald-browser image via a fargate
# instance when Stage 4 needs it — P1 deploys the lambda API half only.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
  backend "s3" {
    bucket         = "cios-tfstate-262602454064"
    key            = "herald/sol-prod.tfstate"
    region         = "us-east-1"
    dynamodb_table = "cios-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = { project = "cios", service = "herald-sol", engine = "herald", managed_by = "terraform" }
  }
}

variable "zip_path" {
  type    = string
  default = "../../../agents/herald-sol/dist/function.zip"
}

module "agent" {
  source = "../../modules/agent-service"

  agent    = "sol"
  env      = "prod"
  variant  = "lambda"
  zip_path = var.zip_path

  # Panel-content checks route through Vera (SPEC-H section 4).
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
