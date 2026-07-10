# Secrets Manager placeholders — SEC-3: each agent instance owns its prefix.
# VALUES ARE NEVER IN TERRAFORM OR ON DISK. Seeded post-apply by
# seed-herald-secrets.mjs via the .op-agent env-injection pattern
# (op://CIOS-prod/... to PutSecretValue), sibling of cf-mo seed-secrets.mjs.
resource "aws_secretsmanager_secret" "s" {
  for_each = toset(var.secret_keys)
  name     = "${local.secrets_prefix}/${each.key}"
}
