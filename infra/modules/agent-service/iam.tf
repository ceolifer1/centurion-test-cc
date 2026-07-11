# ---- IAM (SEC-3 least privilege — every grant scoped to this agent's own names) ----

# == scheduler role (both variants) — EventBridge Scheduler assumes this ==
data "aws_iam_policy_document" "sched_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.sched_assume.json
}

resource "aws_iam_role_policy" "sched_invoke" {
  count = local.lambda_count
  name  = "${local.name}-sched-invoke"
  role  = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "lambda:InvokeFunction", Resource = aws_lambda_function.fn[0].arn }]
  })
}

# Fargate scheduler: RunTask on this family + PassRole on this task's two roles,
# plus StopTask for the out-of-container run-stop one-shots (SPEC-B section 4.5).
data "aws_iam_policy_document" "sched_runtask" {
  count = local.fargate_count
  statement {
    sid       = "RunOwnTask"
    actions   = ["ecs:RunTask"]
    resources = ["arn:aws:ecs:us-east-1:${local.account_id}:task-definition/${local.name}:*"]
  }
  statement {
    sid       = "PassOwnTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.task[0].arn, aws_iam_role.ecsexec[0].arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    sid       = "StopOwnTask"
    actions   = ["ecs:StopTask", "ecs:DescribeTasks"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [local.browser_cluster_arn]
    }
  }
}

resource "aws_iam_role_policy" "sched_runtask" {
  count  = local.fargate_count
  name   = "${local.name}-sched-runtask"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.sched_runtask[0].json
}

# == lambda exec role ==
data "aws_iam_policy_document" "lambda_assume" {
  count = local.lambda_count
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "exec" {
  count              = local.lambda_count
  name               = "${local.name}-exec"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume[0].json
}

resource "aws_iam_role_policy_attachment" "basic" {
  count      = local.lambda_count
  role       = aws_iam_role.exec[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "exec_perms" {
  count = local.lambda_count

  statement {
    sid       = "ReadOwnSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${local.secrets_arn_prefix}/*"]
  }
  statement {
    sid       = "OwnSchedulesOnly"
    actions   = ["scheduler:CreateSchedule", "scheduler:DeleteSchedule"]
    resources = ["arn:aws:scheduler:us-east-1:${local.account_id}:schedule/default/${var.name_prefix}-${var.agent}-*"]
  }
  statement {
    sid       = "PassOwnSchedulerRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.scheduler.arn]
  }
  statement {
    sid       = "HeraldMetricsOnly"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["CIOS/Herald"]
    }
  }

  # Explicit chain edges — nothing transitive (SPEC-H section 4).
  dynamic "statement" {
    for_each = length(var.invoke_peers) > 0 ? [1] : []
    content {
      sid       = "InvokePeersOnly"
      actions   = ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"]
      resources = [for p in var.invoke_peers : "arn:aws:lambda:us-east-1:${local.account_id}:function:${var.name_prefix}-${p}-${var.env}"]
    }
  }

  dynamic "statement" {
    for_each = length(var.run_task_peers) > 0 ? [1] : []
    content {
      sid       = "RunTaskPeersOnly"
      actions   = ["ecs:RunTask"]
      resources = [for p in var.run_task_peers : "arn:aws:ecs:us-east-1:${local.account_id}:task-definition/${var.name_prefix}-${p}-${var.env}:*"]
    }
  }
  dynamic "statement" {
    for_each = length(var.run_task_peers) > 0 ? [1] : []
    content {
      sid     = "PassPeerTaskRoles"
      actions = ["iam:PassRole"]
      resources = flatten([for p in var.run_task_peers : [
        "arn:aws:iam::${local.account_id}:role/${var.name_prefix}-${p}-${var.env}-task",
        "arn:aws:iam::${local.account_id}:role/${var.name_prefix}-${p}-${var.env}-ecsexec"
      ]])
      condition {
        test     = "StringEquals"
        variable = "iam:PassedToService"
        values   = ["ecs-tasks.amazonaws.com"]
      }
    }
  }
  dynamic "statement" {
    for_each = length(var.run_task_peers) > 0 ? [1] : []
    content {
      sid       = "StopPeerTasksOnCluster"
      actions   = ["ecs:StopTask", "ecs:DescribeTasks"]
      resources = ["*"]
      condition {
        test     = "ArnEquals"
        variable = "ecs:cluster"
        values   = [local.browser_cluster_arn]
      }
    }
  }
}

resource "aws_iam_role_policy" "exec_perms" {
  count  = local.lambda_count
  name   = "${local.name}-perms"
  role   = aws_iam_role.exec[0].id
  policy = data.aws_iam_policy_document.exec_perms[0].json
}

# == fargate roles ==
data "aws_iam_policy_document" "ecs_tasks_assume" {
  count = local.fargate_count
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecsexec" {
  count              = local.fargate_count
  name               = "${local.name}-ecsexec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume[0].json
}

resource "aws_iam_role_policy_attachment" "ecsexec_managed" {
  count      = local.fargate_count
  role       = aws_iam_role.ecsexec[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecsexec_secrets" {
  count = local.fargate_count
  name  = "${local.name}-ecsexec-secrets"
  role  = aws_iam_role.ecsexec[0].id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = "${local.secrets_arn_prefix}/*" }]
  })
}

resource "aws_iam_role" "task" {
  count              = local.fargate_count
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume[0].json
}

data "aws_iam_policy_document" "task_perms" {
  count = local.fargate_count

  statement {
    sid       = "ReadOwnSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${local.secrets_arn_prefix}/*"]
  }

  # Session vault — Secrets Manager half only. Decryption additionally requires
  # the per-user CMK grant (alias herald-user-<uuid>, Stage-2 consent flow) —
  # revoking one user revokes decryption without touching this role.
  dynamic "statement" {
    for_each = var.session_secret_read ? [1] : []
    content {
      sid       = "ReadSessionSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = ["arn:aws:secretsmanager:us-east-1:${local.account_id}:secret:herald/sessions/*"]
    }
  }

  statement {
    sid       = "HeraldMetricsOnly"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["CIOS/Herald"]
    }
  }
  statement {
    sid       = "DeleteOwnRunOneShots"
    actions   = ["scheduler:DeleteSchedule"]
    resources = ["arn:aws:scheduler:us-east-1:${local.account_id}:schedule/default/${var.name_prefix}-${var.agent}-run-*"]
  }
  statement {
    sid       = "SelfStopOnCluster"
    actions   = ["ecs:StopTask", "ecs:DescribeTasks"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [local.browser_cluster_arn]
    }
  }

  # Completion callbacks (e.g. Piper reports back to Vera's watch_live).
  dynamic "statement" {
    for_each = length(var.invoke_peers) > 0 ? [1] : []
    content {
      sid       = "InvokePeersOnly"
      actions   = ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"]
      resources = [for p in var.invoke_peers : "arn:aws:lambda:us-east-1:${local.account_id}:function:${var.name_prefix}-${p}-${var.env}"]
    }
  }
}

resource "aws_iam_role_policy" "task_perms" {
  count  = local.fargate_count
  name   = "${local.name}-task-perms"
  role   = aws_iam_role.task[0].id
  policy = data.aws_iam_policy_document.task_perms[0].json
}

# == managed invoke policy for THIS agent — attached by peers/signers, never a wildcard ==
resource "aws_iam_policy" "invoke" {
  count = local.lambda_count
  name  = "${local.name}-invoke"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"]
      Resource = aws_lambda_function.fn[0].arn
    }]
  })
}
