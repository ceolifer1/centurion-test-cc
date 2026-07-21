# HERALD OAuth token vault module — the KMS-CMK-encrypted store for LinkedIn
# 3-legged OAuth member tokens (NOT cookies). Repurposes the retired session-vault
# KMS approach for OAuth TOKENS. One CMK, one alias, one Secrets Manager secret
# shell per person at herald/oauth/linkedin/<person>. The per-person envelope
# ({access_token, refresh_token, expires_at, scope, author_urn}) is written at
# OAuth-capture time (Ashton's one-time Allow) — Terraform never holds a token.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
}

variable "name_prefix" {
  type    = string
  default = "herald"
}

variable "alias" {
  type        = string
  default     = "alias/herald/oauth/linkedin"
  description = "KMS key alias for the LinkedIn OAuth token CMK"
}

variable "vault_prefix" {
  type        = string
  default     = "herald/oauth/linkedin"
  description = "Secrets Manager path prefix for the per-person token envelopes"
}

variable "persons" {
  type        = list(string)
  default     = ["ashton-couture"]
  description = "People whose token secret shell is pre-created (Ashton first; add Jasmine etc. later)"
}

variable "lambda_role_arn" {
  type        = string
  default     = ""
  description = "herald-linkedin Lambda exec role ARN — the ONLY non-root principal granted kms:Decrypt/Encrypt on the CMK (no human role decrypts)"
}

variable "tags" {
  type    = map(string)
  default = {}
}
