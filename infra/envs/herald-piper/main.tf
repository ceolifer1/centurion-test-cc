# HERALD agent stack — piper (fargate, Playwright publisher). State: herald/piper-prod.tfstate.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
  backend "s3" {
    bucket         = "cios-tfstate-262602454064"
    key            = "herald/piper-prod.tfstate"
    region         = "us-east-1"
    dynamodb_table = "cios-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = { project = "cios", service = "herald-piper", engine = "herald", managed_by = "terraform" }
  }
}

data "terraform_remote_state" "shared" {
  backend = "s3"
  config = {
    bucket = "cios-tfstate-262602454064"
    key    = "herald/shared-prod.tfstate"
    region = "us-east-1"
  }
}

# Default-VPC posture (no NAT — public IP + egress-only SG) until the CIOS
# gateway lands. Recorded, not re-litigated here (SPEC-B section 4.4).
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

variable "container_image" {
  type    = string
  default = "262602454064.dkr.ecr.us-east-1.amazonaws.com/herald-browser:piper-latest"
}

module "agent" {
  source = "../../modules/agent-service"

  agent   = "piper"
  env     = "prod"
  variant = "fargate"

  cluster_arn      = data.terraform_remote_state.shared.outputs.cluster_arn
  container_image  = var.container_image
  vpc_id           = data.aws_vpc.default.id
  subnet_ids       = data.aws_subnets.default.ids
  assign_public_ip = true

  # Publishes on behalf of users — may read the session vault (per-user KMS gate on top).
  session_secret_read = true

  # Completion callback to Vera's confirm_posted (SPEC-H section 4 step 9).
  invoke_peers = ["vera"]
}

output "service_name" {
  value = module.agent.service_name
}
output "task_definition_arn" {
  value = module.agent.task_definition_arn
}
output "task_role_arn" {
  value = module.agent.task_role_arn
}
output "scheduler_role_arn" {
  value = module.agent.scheduler_role_arn
}
output "secret_arns" {
  value = module.agent.secret_arns
}
output "security_group_id" {
  value = module.agent.security_group_id
}
output "subnet_ids" {
  value = module.agent.subnet_ids
}
