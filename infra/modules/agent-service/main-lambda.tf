# ---- lambda variant (SPEC-B section 3) — generalizes cf-mandate-ops infra/service ----

# Per-agent ECR repo only when package_type = image (P1 ships all lambda agents as zip).
resource "aws_ecr_repository" "agent" {
  count                = local.is_lambda && var.package_type == "image" ? 1 : 0
  name                 = "${var.name_prefix}-${var.agent}"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_cloudwatch_log_group" "lambda" {
  count             = local.lambda_count
  name              = "/aws/lambda/${local.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "fn" {
  count         = local.lambda_count
  function_name = local.name
  role          = aws_iam_role.exec[0].arn
  package_type  = var.package_type == "image" ? "Image" : "Zip"

  # zip path — the cf-mandate-ops-proven shape
  runtime          = var.package_type == "zip" ? "nodejs20.x" : null
  handler          = var.package_type == "zip" ? "src/index.handler" : null
  filename         = var.package_type == "zip" ? var.zip_path : null
  source_code_hash = var.package_type == "zip" ? filebase64sha256(var.zip_path) : null

  # image path — parity with the module contract (unused in P1)
  image_uri = var.package_type == "image" ? "${aws_ecr_repository.agent[0].repository_url}:${var.image_tag}" : null

  timeout     = var.timeout
  memory_size = var.memory_size

  environment {
    variables = merge({
      SELF_FUNCTION_ARN  = "arn:aws:lambda:us-east-1:${local.account_id}:function:${local.name}"
      SCHEDULER_ROLE_ARN = aws_iam_role.scheduler.arn
    }, local.base_env, var.extra_env)
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

# AWS_IAM only — no public endpoint. Callers: the herald-signer Vercel proxy and
# peer agents (SPEC-H). App-level Supabase auth still enforced in-handler.
resource "aws_lambda_function_url" "url" {
  count              = local.lambda_count
  function_name      = aws_lambda_function.fn[0].function_name
  authorization_type = "AWS_IAM"
}
