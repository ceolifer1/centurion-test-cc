# ---- per-agent CloudWatch alarms (SPEC-B section 6C) ----
# NOTE: CloudWatch caps an alarm's evaluation window (period x evaluation_periods)
# at 86400 seconds, so the spec's "SUM over 30 days" spend alarm is expressed as
# the daily prorated sum (monthly threshold / 30). These are advisory — the
# engine-wide 400 USD hard stop is enforced in-app on agent_usage (SPEC-B 6A).

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  count               = local.lambda_count
  alarm_name          = "${local.name}-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = var.alarm_error_threshold
  dimensions          = { FunctionName = local.name }
  alarm_actions       = local.alarm_actions
}

# Fargate errors come from the entrypoint-emitted RunFailed custom metric.
resource "aws_cloudwatch_metric_alarm" "fargate_errors" {
  count               = local.fargate_count
  alarm_name          = "${local.name}-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "RunFailed"
  namespace           = "CIOS/Herald"
  period              = 300
  statistic           = "Sum"
  threshold           = var.alarm_error_threshold
  dimensions          = { Agent = var.agent, Env = var.env }
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "duration" {
  count               = local.lambda_count
  alarm_name          = "${local.name}-duration"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 300
  extended_statistic  = "p95"
  threshold           = var.timeout * 1000 * 0.8
  dimensions          = { FunctionName = local.name }
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# Advisory per-agent spend alarm — daily prorated slice of the monthly soft
# ceiling (see file header note on the 86400 s evaluation cap).
resource "aws_cloudwatch_metric_alarm" "spend" {
  alarm_name          = "${local.name}-spend"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "SpendUSD"
  namespace           = "CIOS/Herald"
  period              = 86400
  statistic           = "Sum"
  threshold           = var.monthly_spend_alarm_usd / 30
  dimensions          = { Agent = var.agent, Env = var.env }
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# Fired only if the in-container watchdog wall was actually hit — investigate.
resource "aws_cloudwatch_metric_alarm" "runtime" {
  count               = local.fargate_count
  alarm_name          = "${local.name}-runtime"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "RunSeconds"
  namespace           = "CIOS/Herald"
  period              = 300
  statistic           = "Maximum"
  threshold           = var.max_runtime_seconds
  dimensions          = { Agent = var.agent, Env = var.env }
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}
