# HERALD agent stack — gia (lambda, COMPLIANT official-API engagement).
# State: herald/gia-prod.tfstate. Engages through LinkedIn's versioned REST
# reactions + social-actions endpoints on a 3-legged OAuth member token read from
# the SAME vault herald-linkedin writes (herald/oauth/linkedin/<person>, CMK
# alias/herald/oauth/linkedin) — NO cookies, NO browser, NO Fargate. The prior
# Fargate/Playwright/session-cookie stack is RETIRED.
#
# This stack is a Lambda + exec role + log group + scheduler role + AWS_IAM
# Function URL (all from the agent-service module) PLUS a scoped inline policy
# granting the exec role kms:Decrypt on the LinkedIn OAuth CMK and read on the
# token-vault secrets. Gia READS the vault; herald-linkedin CREATES it — so this
# stack references the existing CMK by alias and never provisions its own.
# Engagement is target-driven: the Cass peer (or the dashboard) invokes the
# AWS_IAM Function URL with a curated target list — Gia does NOT scan the feed, so
# there is no time-based schedule (the scheduler role is available for future use).
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

  memory_size = 256
  timeout     = 60

  # manage_company_page may draft with Anthropic; engage + enqueue_follow are
  # deterministic. cf keys for Supabase, anthropic-key for the drafting path.
  secret_keys = ["cf-service-key", "cf-anon-key", "anthropic-key"]

  # Re-verifies comment copy + company-page drafts through Vera (SPEC-H 4).
  invoke_peers = ["vera"]

  extra_env = {
    HERALD_LIVE           = "false"
    LINKEDIN_VERSION      = "202606"
    LINKEDIN_ORG_ENABLED  = "false"
    OAUTH_VAULT_PREFIX    = "herald/oauth/linkedin"
    ENGAGE_REQUIRED_SCOPE = "w_member_social_feed"
    VERA_FUNCTION         = "herald-vera-prod"
    ALLOWED_CALLERS       = "cass"
  }
}

data "aws_caller_identity" "me" {}

# The LinkedIn OAuth CMK is created + owned by the herald-linkedin stack
# (alias/herald/oauth/linkedin). Gia only READS the vault, so it references the
# existing key by alias — it never provisions a second CMK for the same secrets.
data "aws_kms_alias" "linkedin_oauth" {
  name = "alias/herald/oauth/linkedin"
}

# Scoped vault READ for the Lambda identity: GetSecretValue on the per-person
# token envelopes and kms:Decrypt under the LinkedIn OAuth CMK. The agent-service
# module already grants read on herald/gia/* + the log group + scheduler role +
# AWS_IAM Function URL — this policy adds ONLY the cross-stack vault read.
data "aws_iam_policy_document" "vault_read" {
  statement {
    sid       = "TokenVaultRead"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = ["arn:aws:secretsmanager:us-east-1:${data.aws_caller_identity.me.account_id}:secret:herald/oauth/linkedin/*"]
  }
  statement {
    sid       = "TokenVaultKmsDecrypt"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [data.aws_kms_alias.linkedin_oauth.target_key_arn]
  }
}

locals {
  # main's agent-service module exposes exec_role_arn (not the name); derive the
  # role name from the ARN tail (arn:aws:iam::acct:role/<name>).
  exec_role_name = element(split("/", module.agent.exec_role_arn), length(split("/", module.agent.exec_role_arn)) - 1)
}

resource "aws_iam_role_policy" "vault_read" {
  name   = "herald-gia-oauth-vault-read"
  role   = local.exec_role_name
  policy = data.aws_iam_policy_document.vault_read.json
}

output "service_name" {
  value = module.agent.service_name
}
output "function_url" {
  value = module.agent.function_url
}
output "function_arn" {
  value = module.agent.function_arn
}
output "exec_role_arn" {
  value = module.agent.exec_role_arn
}
output "scheduler_role_arn" {
  value = module.agent.scheduler_role_arn
}
output "secret_arns" {
  value = module.agent.secret_arns
}
output "linkedin_oauth_key_arn" {
  value = data.aws_kms_alias.linkedin_oauth.target_key_arn
}
