variable "persons" {
  type        = list(string)
  description = "Fact-file person ids that get a per-person CMK (the locked run roster). One key each — alias/herald/user/<person>."
}

variable "decrypt_role_arns" {
  type        = list(string)
  description = "Fargate agent task roles that may kms:Decrypt a session (Piper publisher, Sol browser). Gia is a Lambda and is deliberately NOT here — Lambda roles never read session cookies. Per-person isolation is enforced by the aws:PrincipalTag/herald:person condition."
}

variable "capture_role_arn" {
  type        = string
  description = "The ephemeral capture task role (kms:Encrypt only, tag-conditioned per person)."
}

variable "vault_lambda_role_arn" {
  type        = string
  description = "The herald-vault Lambda exec role (grant retire/revoke on revoke — never Decrypt)."
}

variable "key_admin_role_arn" {
  type        = string
  description = "The herald-deploy OIDC role (key administration via Terraform — never Encrypt/Decrypt). SEC-2: no long-lived admin key."
}
