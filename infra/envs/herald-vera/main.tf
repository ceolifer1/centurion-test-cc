# HERALD agent stack — vera (lambda, THE GATE: nothing publishes around her).
# State: herald/vera-prod.tfstate.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
  backend "s3" {
    bucket         = "cios-tfstate-262602454064"
    key            = "herald/vera-prod.tfstate"
    region         = "us-east-1"
    dynamodb_table = "cios-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = { project = "cios", service = "herald-vera", engine = "herald", managed_by = "terraform" }
  }
}

variable "zip_path" {
  type    = string
  default = "../../../agents/herald-vera/dist/function.zip"
}

module "agent" {
  source = "../../modules/agent-service"

  agent    = "vera"
  env      = "prod"
  variant  = "lambda"
  zip_path = var.zip_path

  # Vera is the ONLY agent allowed to start Piper browser runs (SPEC-H section 4).
  run_task_peers = ["piper"]
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
