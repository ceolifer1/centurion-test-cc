output "service_name" {
  value = local.name
}

output "function_url" {
  value = local.is_lambda ? aws_lambda_function_url.url[0].function_url : ""
}

output "function_arn" {
  value = local.is_lambda ? aws_lambda_function.fn[0].arn : ""
}

output "function_name" {
  value = local.is_lambda ? aws_lambda_function.fn[0].function_name : ""
}

output "task_definition_arn" {
  value = local.is_fargate ? aws_ecs_task_definition.task[0].arn : ""
}

output "task_role_arn" {
  value = local.is_fargate ? aws_iam_role.task[0].arn : ""
}

output "exec_role_arn" {
  description = "Lambda exec role or fargate execution role"
  value       = local.is_lambda ? aws_iam_role.exec[0].arn : aws_iam_role.ecsexec[0].arn
}

output "scheduler_role_arn" {
  value = aws_iam_role.scheduler.arn
}

output "log_group_name" {
  value = local.log_group_name
}

output "ecr_repo_url" {
  value = length(aws_ecr_repository.agent) > 0 ? aws_ecr_repository.agent[0].repository_url : ""
}

output "secret_arns" {
  value = { for k, v in aws_secretsmanager_secret.s : k => v.arn }
}

output "invoke_policy_arn" {
  description = "Managed policy allowing invoke on THIS agent only — attached by peers/signers, never resources = all"
  value       = local.is_lambda ? aws_iam_policy.invoke[0].arn : ""
}

output "security_group_id" {
  value = local.is_fargate ? aws_security_group.task[0].id : ""
}

# Fargate networking is supplied at RunTask time (awsvpcConfiguration), not in
# the task definition — callers read these to build the RunTask request.
output "subnet_ids" {
  value = var.subnet_ids
}

output "assign_public_ip" {
  value = var.assign_public_ip
}
