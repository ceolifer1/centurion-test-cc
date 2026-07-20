output "key_arns" {
  description = "Per-person CMK ARNs, keyed by person id."
  value       = { for k, v in aws_kms_key.user : k => v.arn }
}

output "key_aliases" {
  description = "Per-person alias names (alias/herald/user/<person>)."
  value       = { for k, v in aws_kms_alias.user : k => v.name }
}
