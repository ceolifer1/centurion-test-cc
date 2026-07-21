# HERALD agent stack — linkedin (lambda, COMPLIANT official-API publisher).
# State: herald/linkedin-prod.tfstate. Posts through LinkedIn's REST /rest/posts
# on a 3-legged OAuth member token (w_member_social) — NO cookies, NO browser.
# Everything here is additive: a new Lambda + role + log group, a NEW KMS CMK +
# per-person token secret shells, and two DISABLED schedules. Nothing posts until
# (a) Ashton runs the one-time OAuth capture and (b) HERALD_LIVE is flipped on.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
  backend "s3" {
    bucket         = "cios-tfstate-262602454064"
    key            = "herald/linkedin-prod.tfstate"
    region         = "us-east-1"
    dynamodb_table = "cios-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = { project = "cios", service = "herald-linkedin", engine = "herald", managed_by = "terraform" }
  }
}

variable "zip_path" {
  type    = string
  default = "../../../agents/herald-linkedin/dist/function.zip"
}

module "agent" {
  source = "../../modules/agent-service"

  agent    = "linkedin"
  env      = "prod"
  variant  = "lambda"
  zip_path = var.zip_path

  memory_size = 256
  timeout     = 60

  # No Anthropic key — this agent spends zero model tokens (Vera is deterministic).
  secret_keys = ["cf-service-key", "cf-anon-key", "client-id", "client-secret"]

  # Re-verifies every post through Vera before it goes out (SPEC-H section 4).
  invoke_peers = ["vera"]

  extra_env = {
    HERALD_LIVE           = "false"
    LINKEDIN_VERSION      = "202506"
    LINKEDIN_ORG_ENABLED  = "false"
    OAUTH_VAULT_PREFIX    = "herald/oauth/linkedin"
    VERA_FUNCTION         = "herald-vera-prod"
    REFRESH_PERSONS       = "ashton-couture"
  }
}

# OAuth TOKEN vault — new CMK + alias + per-person secret shells. The Lambda role
# is the ONLY non-root principal that may use the key (read a token / write a
# refresh). No human/operator role gets a standing decrypt grant.
module "oauth_vault" {
  source = "../../modules/oauth-vault"

  name_prefix     = "herald"
  alias           = "alias/herald/oauth/linkedin"
  vault_prefix    = "herald/oauth/linkedin"
  persons         = ["ashton-couture"]
  lambda_role_arn = module.agent.exec_role_arn
  tags            = { project = "cios", service = "herald-linkedin", engine = "herald", managed_by = "terraform" }
}

# Scoped vault access for the Lambda identity: read/write the per-person token
# envelopes and use the CMK. Attached to the module's exec role by name (keeps the
# shared agent-service module untouched). Belt-and-suspenders with the key policy.
data "aws_iam_policy_document" "vault_access" {
  statement {
    sid       = "TokenVaultReadWrite"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret"]
    resources = ["arn:aws:secretsmanager:us-east-1:${data.aws_caller_identity.me.account_id}:secret:herald/oauth/linkedin/*"]
  }
  statement {
    sid       = "TokenVaultKmsUse"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [module.oauth_vault.key_arn]
  }
}

data "aws_caller_identity" "me" {}

resource "aws_iam_role_policy" "vault_access" {
  name   = "herald-linkedin-oauth-vault"
  role   = module.agent.exec_role_name
  policy = data.aws_iam_policy_document.vault_access.json
}

# EventBridge schedule — publish sweep. HERALD schedules and posts on wake because
# LinkedIn has no scheduling endpoint. Created DISABLED and pointed at dry-run
# (HERALD_LIVE off) so NOTHING fires or posts until armed. Arm = enable the
# schedule (rehearsal) then flip HERALD_LIVE=true (Ashton/Linda, after OAuth).
resource "aws_scheduler_schedule" "publish" {
  name       = "herald-linkedin-publish-prod"
  state      = "DISABLED"
  group_name = "default"

  flexible_time_window {
    mode = "OFF"
  }

  # 09:05 America/Chicago, Mon-Fri (inside SPEC-D active hours for posts).
  schedule_expression          = "cron(5 9 ? * MON-FRI *)"
  schedule_expression_timezone = "America/Chicago"

  target {
    arn      = module.agent.function_arn
    role_arn = module.agent.scheduler_role_arn
    input = jsonencode({
      task    = "publish_due"
      mode    = "scheduled"
      payload = {}
      trace   = { chain = [] }
    })
  }
}

# EventBridge schedule — token refresh sweep. DISABLED until armed. Refreshes
# access tokens nearing expiry so the member never has to re-consent unnecessarily.
resource "aws_scheduler_schedule" "refresh" {
  name       = "herald-linkedin-refresh-prod"
  state      = "DISABLED"
  group_name = "default"

  flexible_time_window {
    mode = "OFF"
  }

  # 06:00 America/Chicago daily.
  schedule_expression          = "cron(0 6 * * ? *)"
  schedule_expression_timezone = "America/Chicago"

  target {
    arn      = module.agent.function_arn
    role_arn = module.agent.scheduler_role_arn
    input = jsonencode({
      task    = "refresh_tokens"
      mode    = "scheduled"
      payload = {}
      trace   = { chain = [] }
    })
  }
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
output "scheduler_role_arn" {
  value = module.agent.scheduler_role_arn
}
output "secret_arns" {
  value = module.agent.secret_arns
}
output "oauth_vault_key_arn" {
  value = module.oauth_vault.key_arn
}
output "oauth_vault_alias" {
  value = module.oauth_vault.alias
}
output "oauth_vault_secret_arns" {
  value = module.oauth_vault.secret_arns
}
output "publish_schedule_arn" {
  value = aws_scheduler_schedule.publish.arn
}
output "refresh_schedule_arn" {
  value = aws_scheduler_schedule.refresh.arn
}
