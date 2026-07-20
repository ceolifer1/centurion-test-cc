# session-vault submodule (SPEC-C 4.1 / 9) — one KMS CMK per person, alias
# alias/herald/user/<person>, with the key policy that is the REAL isolation
# boundary. Jasmine's key cannot decrypt Ashton's sessions even if IAM elsewhere
# is misconfigured. NO human role gets Decrypt (root retains kms:* only as the
# standard lockout-prevention delegation to IAM — that is the accepted T6 residual
# in SPEC-C 8). Secrets themselves are seeded by the capture flow (PutSecretValue),
# NEVER by Terraform (SPEC-C 4.2 / 9). Deploy ordering: the agent + capture + vault
# roles referenced below must exist before these keys apply (next key window).
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
}

data "aws_caller_identity" "me" {}

locals {
  account_id = data.aws_caller_identity.me.account_id
}

resource "aws_kms_key" "user" {
  for_each                = toset(var.persons)
  description             = "HERALD per-person session-vault CMK for ${each.key} (SPEC-C 4.1)"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid       = "RootEnableIamDelegation"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "PerPersonAgentDecrypt"
        Effect    = "Allow"
        Principal = { AWS = var.decrypt_role_arns }
        Action    = ["kms:Decrypt", "kms:DescribeKey"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:PrincipalTag/herald:person" = each.key } }
      },
      {
        Sid       = "CaptureEncrypt"
        Effect    = "Allow"
        Principal = { AWS = var.capture_role_arn }
        Action    = ["kms:Encrypt", "kms:GenerateDataKey", "kms:ReEncryptFrom", "kms:ReEncryptTo", "kms:DescribeKey"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:PrincipalTag/herald:person" = each.key } }
      },
      {
        Sid       = "VaultRevokeGrants"
        Effect    = "Allow"
        Principal = { AWS = var.vault_lambda_role_arn }
        Action    = ["kms:RetireGrant", "kms:RevokeGrant", "kms:ListGrants", "kms:DescribeKey"]
        Resource  = "*"
      },
      {
        Sid       = "DeployKeyAdmin"
        Effect    = "Allow"
        Principal = { AWS = var.key_admin_role_arn }
        Action    = ["kms:Describe*", "kms:List*", "kms:Get*", "kms:Enable*", "kms:Disable*", "kms:Put*",
          "kms:Update*", "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion"]
        Resource  = "*"
      },
    ])
  })

  tags = {
    "herald:person" = each.key
    "herald:class"  = "session-vault"
  }
}

resource "aws_kms_alias" "user" {
  for_each      = toset(var.persons)
  name          = "alias/herald/user/${each.key}"
  target_key_id = aws_kms_key.user[each.key].key_id
}
