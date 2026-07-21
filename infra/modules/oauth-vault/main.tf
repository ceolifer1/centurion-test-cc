data "aws_caller_identity" "me" {}

locals {
  account_id = data.aws_caller_identity.me.account_id
  # Key policy: root retains standard key ADMINISTRATION (required, or the key
  # becomes unmanageable) but NOT a standing decrypt-for-use grant to any human
  # operator. The herald-linkedin Lambda role is the only principal that may USE
  # the key (Decrypt to read a token, Encrypt/GenerateDataKey to write a refresh).
  base_statements = [
    {
      Sid       = "RootKeyAdministration"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }
      Action = [
        "kms:Create*", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*",
        "kms:Update*", "kms:Revoke*", "kms:Disable*", "kms:Get*", "kms:Delete*",
        "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion"
      ]
      Resource = "*"
    }
  ]
  lambda_statements = var.lambda_role_arn != "" ? [
    {
      Sid       = "HeraldLinkedinLambdaUseOnly"
      Effect    = "Allow"
      Principal = { AWS = var.lambda_role_arn }
      Action    = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
      Resource  = "*"
    }
  ] : []

  # AWS-standard CMK-for-Secrets-Manager pattern: the key may be used only THROUGH
  # the Secrets Manager service (kms:ViaService) by principals in THIS account.
  # This lets the deployer create the CMK-encrypted secret and lets the Lambda
  # read/refresh it via GetSecretValue/PutSecretValue - but there is NO direct
  # kms:Decrypt path for a human. Since secretsmanager:GetSecretValue on the token
  # vault path is granted ONLY to the Lambda role, no human role can decrypt a token.
  viaservice_statements = [
    {
      Sid       = "AllowUseThroughSecretsManagerInThisAccount"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }
      Action    = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:CreateGrant", "kms:DescribeKey"]
      Resource  = "*"
      Condition = {
        StringEquals = {
          "kms:ViaService"    = "secretsmanager.us-east-1.amazonaws.com"
          "kms:CallerAccount" = local.account_id
        }
      }
    }
  ]
}

resource "aws_kms_key" "oauth" {
  description             = "HERALD LinkedIn OAuth token vault CMK — encrypts herald/oauth/linkedin/<person> token envelopes"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = concat(local.base_statements, local.viaservice_statements, local.lambda_statements)
  })
  tags = var.tags
}

resource "aws_kms_alias" "oauth" {
  name          = var.alias
  target_key_id = aws_kms_key.oauth.key_id
}

# Per-person token secret SHELLS (no version — the first version is written by the
# one-time OAuth capture via PutSecretValue). A GetSecretValue before capture
# returns ResourceNotFound, which the Lambda reads as NOT_CONNECTED (no post).
resource "aws_secretsmanager_secret" "token" {
  for_each   = toset(var.persons)
  name       = "${var.vault_prefix}/${each.key}"
  kms_key_id = aws_kms_key.oauth.arn
  tags       = var.tags
}
