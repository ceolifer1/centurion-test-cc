output "key_arn" {
  value = aws_kms_key.oauth.arn
}

output "key_id" {
  value = aws_kms_key.oauth.key_id
}

output "alias" {
  value = aws_kms_alias.oauth.name
}

output "vault_prefix" {
  value = var.vault_prefix
}

output "secret_arns" {
  value = { for k, v in aws_secretsmanager_secret.token : k => v.arn }
}
