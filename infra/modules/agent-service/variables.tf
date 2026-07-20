# HERALD agent-service module — SPEC-B (Presence Engine Phase 0).
# One agent = one service: its own IAM role, secret prefix, log group, rate
# limit, and alarms (SEC-3 / R5) — enforced by construction.
# Variants: lambda (Vera, Nico, Cass, Rhea, Sol API half) and fargate
# (Piper, Gia, Sol browser half). No aws_ecs_service on purpose — browser
# tasks are RunTask-only (SPEC-B section 4.5).

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
}

variable "agent" {
  type        = string
  description = "Short agent name: vera, nico, piper, gia, sol, cass, rhea"
}

variable "env" {
  type    = string
  default = "prod"
}

variable "variant" {
  type        = string
  description = "lambda or fargate"
  validation {
    condition     = contains(["lambda", "fargate"], var.variant)
    error_message = "variant must be lambda or fargate."
  }
}

variable "name_prefix" {
  type        = string
  default     = "herald"
  description = "Service name prefix — override for the future cf-mandate-ops re-platform (SPEC-B section 8)"
}

variable "secrets_prefix" {
  type        = string
  default     = ""
  description = "Secrets Manager prefix — empty means herald/agent-name (override for the cf-mo re-platform)"
}

variable "secret_keys" {
  type    = list(string)
  default = ["anthropic-key", "cf-service-key", "cf-anon-key"]
}

variable "extra_env" {
  type    = map(string)
  default = {}
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "invoke_peers" {
  type        = list(string)
  default     = []
  description = "Agent names this agent may invoke directly — the explicit chain edges of SPEC-H section 4"
}

variable "run_task_peers" {
  type        = list(string)
  default     = []
  description = "Fargate agent names this agent may ecs:RunTask (lambda variant)"
}

variable "alarm_error_threshold" {
  type    = number
  default = 3
}

variable "monthly_spend_alarm_usd" {
  type        = number
  default     = 60
  description = "Per-agent Anthropic soft-alarm threshold on CIOS/Herald SpendUSD — the 400 USD hard cap is engine-wide, enforced in-app"
}

variable "alarm_sns_topic_arn" {
  type    = string
  default = ""
}

# ---- lambda variant ----

variable "package_type" {
  type    = string
  default = "zip"
  validation {
    condition     = contains(["zip", "image"], var.package_type)
    error_message = "package_type must be zip or image."
  }
}

variable "zip_path" {
  type        = string
  default     = ""
  description = "Path to dist/function.zip — required when package_type = zip"
}

variable "image_tag" {
  type    = string
  default = "latest"
}

variable "memory_size" {
  type    = number
  default = 512
}

variable "timeout" {
  type    = number
  default = 120
}

# ---- fargate variant ----

variable "cluster_arn" {
  type        = string
  default     = ""
  description = "Shared herald-browser cluster ARN from envs/herald-shared (required for fargate)"
}

variable "container_image" {
  type        = string
  default     = ""
  description = "Full ECR image URI — Playwright-capable, from the shared herald-browser repo"
}

variable "cpu" {
  type    = number
  default = 1024
}

variable "memory" {
  type        = number
  default     = 4096
  description = "MB — Chromium under Playwright needs headroom"
}

variable "ephemeral_storage_gib" {
  type        = number
  default     = 30
  description = "Ephemeral only — the browser profile dies with the task"
}

variable "subnet_ids" {
  type    = list(string)
  default = []
}

variable "vpc_id" {
  type    = string
  default = ""
}

variable "assign_public_ip" {
  type        = bool
  default     = true
  description = "Default VPC has no NAT — public IP + egress-only SG is the accepted Phase-1 posture, revisit at CIOS-gateway time"
}

variable "max_runtime_seconds" {
  type        = number
  default     = 2700
  description = "45 min hard wall — enforced in-container (watchdog) and out (StopTask one-shot)"
}

variable "session_secret_read" {
  type        = bool
  default     = false
  description = "Fargate only — grants GetSecretValue on herald/sessions/* (Piper, Gia, Sol). Decryption still gated by per-user CMKs at Stage 2."
}

variable "vault_service" {
  type        = bool
  default     = false
  description = "Lambda only (herald-vault, SPEC-C 6) — grants the DESTRUCTIVE revoke plane: DeleteSecret/DescribeSecret on herald/sessions/*, kms:RetireGrant/RevokeGrant on per-person CMKs (alias/herald/user/*), and RunTask/StopTask on the capture + browser tasks. Deliberately NO GetSecretValue and NO kms:Decrypt — the vault Lambda NEVER reads cookie plaintext (only fargate roles do)."
}

variable "capture_taskdef_family" {
  type        = string
  default     = "herald-vault-capture-prod"
  description = "The ephemeral capture task family the vault Lambda may RunTask (SPEC-C 3)."
}

data "aws_caller_identity" "me" {}

locals {
  account_id          = data.aws_caller_identity.me.account_id
  name                = "${var.name_prefix}-${var.agent}-${var.env}"
  is_lambda           = var.variant == "lambda"
  is_fargate          = var.variant == "fargate"
  lambda_count        = local.is_lambda ? 1 : 0
  fargate_count       = local.is_fargate ? 1 : 0
  secrets_prefix      = var.secrets_prefix != "" ? var.secrets_prefix : "herald/${var.agent}"
  secrets_arn_prefix  = "arn:aws:secretsmanager:us-east-1:${local.account_id}:secret:${local.secrets_prefix}"
  log_group_name      = local.is_lambda ? "/aws/lambda/${local.name}" : "/ecs/${local.name}"
  browser_cluster_arn = var.cluster_arn != "" ? var.cluster_arn : "arn:aws:ecs:us-east-1:${local.account_id}:cluster/${var.name_prefix}-browser-${var.env}"
  alarm_actions       = var.alarm_sns_topic_arn != "" ? [var.alarm_sns_topic_arn] : []
  base_env = {
    SERVICE_ENV    = var.env
    AGENT_NAME     = var.agent
    SECRETS_PREFIX = local.secrets_prefix
    ENGINE         = "herald"
  }
}
