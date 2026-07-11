# ---- fargate variant (SPEC-B section 4) — Playwright browser agents, RunTask-only ----

resource "aws_cloudwatch_log_group" "fargate" {
  count             = local.fargate_count
  name              = "/ecs/${local.name}"
  retention_in_days = var.log_retention_days
}

# Zero ingress. Egress 443 + 80 only — browser agents originate traffic, never
# receive it. Control input = RunTask env overrides, output = Supabase writes +
# CloudWatch (SPEC-B section 4.4). Amazon-provided DNS bypasses SG evaluation.
resource "aws_security_group" "task" {
  count       = local.fargate_count
  name        = "${local.name}-task"
  description = "Egress-only SG for ${local.name} browser tasks"
  vpc_id      = var.vpc_id

  egress {
    description = "HTTPS out"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    description = "HTTP out"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

locals {
  fargate_env = merge(local.base_env, {
    MAX_RUNTIME_SECONDS = tostring(var.max_runtime_seconds)
    CLUSTER_ARN         = local.browser_cluster_arn
  }, var.extra_env)
}

# NOTE: deliberately NO aws_ecs_service — RunTask-only tasks cannot linger idle
# (auto-stop is structural, SPEC-B section 4.5).
resource "aws_ecs_task_definition" "task" {
  count                    = local.fargate_count
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  execution_role_arn       = aws_iam_role.ecsexec[0].arn
  task_role_arn            = aws_iam_role.task[0].arn

  ephemeral_storage {
    size_in_gib = var.ephemeral_storage_gib
  }

  container_definitions = jsonencode([
    {
      name        = local.name
      image       = var.container_image
      essential   = true
      environment = [for k, v in local.fargate_env : { name = k, value = v }]
      # Config secrets only (service credentials MAY be injected — SPEC-B 4.2).
      # Session cookies are NEVER injected here: fetched by agent code at
      # runtime from herald/sessions/<user>/<platform>, KMS-gated per user.
      secrets = [for k in sort(var.secret_keys) : {
        name      = upper(replace(k, "-", "_"))
        valueFrom = aws_secretsmanager_secret.s[k].arn
      }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.fargate[0].name
          awslogs-region        = "us-east-1"
          awslogs-stream-prefix = var.agent
        }
      }
    }
  ])
}
