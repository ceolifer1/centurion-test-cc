# HERALD shared stack — ECS cluster + engine-wide spend alarm (SPEC-B 4.1 / 6A).
# State: herald/shared-prod.tfstate in the existing cios bootstrap bucket.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
  backend "s3" {
    bucket         = "cios-tfstate-262602454064"
    key            = "herald/shared-prod.tfstate"
    region         = "us-east-1"
    dynamodb_table = "cios-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = { project = "cios", service = "herald-shared", engine = "herald", managed_by = "terraform" }
  }
}

# One cluster, many task definitions — the isolation boundary is the per-agent
# task role and log group (SEC-3 at the IAM layer), not the cluster.
resource "aws_ecs_cluster" "herald_browser" {
  name = "herald-browser-prod"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# Engine-wide Anthropic soft alarm — 80% of the 400 USD monthly cap, prorated
# per day (320 / 30 — CloudWatch caps the alarm window at 86400 s). The hard
# stop is enforced in-app on agent_usage (SPEC-B 6A).
resource "aws_cloudwatch_metric_alarm" "engine_spend" {
  alarm_name          = "herald-engine-prod-spend"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 10.67
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "total"
    expression  = "SUM(METRICS())"
    label       = "herald engine daily SpendUSD"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = toset(["vera", "nico", "piper", "gia", "sol", "cass", "rhea"])
    content {
      id = "m_${metric_query.key}"
      metric {
        namespace   = "CIOS/Herald"
        metric_name = "SpendUSD"
        period      = 86400
        stat        = "Sum"
        dimensions  = { Agent = metric_query.key, Env = "prod" }
      }
    }
  }
}

output "cluster_arn" {
  value = aws_ecs_cluster.herald_browser.arn
}

output "cluster_name" {
  value = aws_ecs_cluster.herald_browser.name
}
