# HERALD session-vault stack — herald-vault (lambda) + per-person CMKs (SPEC-C).
# State: herald/vault-prod.tfstate. The Lambda does consent + revoke + status and
# NEVER reads cookie plaintext; the per-person CMKs (session-vault module) are the
# isolation boundary. Secrets (herald/sessions/<person>/<platform>) are seeded by
# the capture flow, NEVER by Terraform (SPEC-C 4.2 / 9).
#
# DEPLOY ORDERING (next ephemeral-key window): the agent Lambda applies first
# (creates herald-vault-prod-exec), then the CMKs — whose key policy references
# the piper task role, the capture task role, the vault exec role, and the
# herald-deploy admin role, all of which must EXIST before the keys validate.
# KMS key creation needs kms:CreateKey (broader than herald-deploy's lambda-code
# rights) — apply this stack at the key window. Nothing here is applied by the
# Stage-5 build agent.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
  backend "s3" {
    bucket         = "cios-tfstate-262602454064"
    key            = "herald/vault-prod.tfstate"
    region         = "us-east-1"
    dynamodb_table = "cios-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = { project = "cios", service = "herald-vault", engine = "herald", managed_by = "terraform" }
  }
}

locals {
  account_id = "262602454064"
  # Run roster (locked 2026-07-10) — one per-person CMK each.
  persons = ["ashton-couture", "jasmine-amaso"]
}

variable "zip_path" {
  type    = string
  default = "../../../agents/herald-vault/dist/function.zip"
}

module "agent" {
  source = "../../modules/agent-service"

  agent       = "vault"
  env         = "prod"
  variant     = "lambda"
  zip_path    = var.zip_path
  secret_keys = ["cf-service-key", "cf-anon-key"]

  # The destructive revoke plane (SPEC-C 6) — DeleteSecret + grant-retire +
  # RunTask/StopTask. No GetSecretValue, no kms:Decrypt: the vault never reads a session.
  vault_service = true
}

module "vault_keys" {
  source = "../../modules/session-vault"

  persons = local.persons

  # Only fargate browser roles that actually read a session may decrypt — Piper
  # (publisher + engagement executor). Sol's browser half can be appended when it
  # ships. Gia is a Lambda and is intentionally absent.
  decrypt_role_arns     = ["arn:aws:iam::${local.account_id}:role/herald-piper-prod-task"]
  capture_role_arn      = "arn:aws:iam::${local.account_id}:role/herald-vault-capture-prod-task"
  vault_lambda_role_arn = module.agent.exec_role_arn
  key_admin_role_arn    = "arn:aws:iam::${local.account_id}:role/herald-deploy"
}

output "service_name" {
  value = module.agent.service_name
}
output "function_url" {
  value = module.agent.function_url
}
output "invoke_policy_arn" {
  value = module.agent.invoke_policy_arn
}
output "secret_arns" {
  value = module.agent.secret_arns
}
output "user_key_aliases" {
  value = module.vault_keys.key_aliases
}
