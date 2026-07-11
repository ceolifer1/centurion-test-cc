# agent-service — HERALD reusable agent Terraform module

Implements **SPEC-B** (`C:\Claude\20-CIOS\Presence-Engine-2026-07-07\phase0\SPEC-B-agent-service-module.md`).
One agent = one service: its own IAM role, secret prefix, log group, and alarms
(SEC-3 / R5) — enforced by construction. Region `us-east-1`, account `262602454064`.

## Variants

| Variant | Agents | Shape |
|---|---|---|
| `lambda` | vera, nico, cass, rhea, sol (API half) | zip Lambda + Function URL (`AWS_IAM`), generalizes the live cf-mandate-ops service. `package_type = "image"` also supported (unused in P1). |
| `fargate` | piper, gia, sol (browser half) | RunTask-only task definition on the shared `herald-browser-prod` cluster. Deliberately **no `aws_ecs_service`** — tasks cannot linger idle. |

## Usage

Lambda agent:

```hcl
module "agent" {
  source   = "../../modules/agent-service"
  agent    = "nico"
  env      = "prod"
  variant  = "lambda"
  zip_path = "../../../agents/herald-nico/dist/function.zip"

  invoke_peers = ["vera"] # explicit chain edges only (SPEC-H section 4)
}
```

Fargate agent:

```hcl
module "agent" {
  source  = "../../modules/agent-service"
  agent   = "piper"
  env     = "prod"
  variant = "fargate"

  cluster_arn         = data.terraform_remote_state.shared.outputs.cluster_arn
  container_image     = "262602454064.dkr.ecr.us-east-1.amazonaws.com/herald-browser:piper-latest"
  vpc_id              = data.aws_vpc.default.id
  subnet_ids          = data.aws_subnets.default.ids
  session_secret_read = true
  invoke_peers        = ["vera"]
}
```

Instance stacks live in `infra/envs/herald-<agent>/` — one directory = one state
(`herald/<agent>-prod.tfstate` in `cios-tfstate-262602454064`, lock `cios-tflock`),
so `terraform destroy` of one agent leaves the other six standing. The shared
cluster + engine-wide spend alarm live in `infra/envs/herald-shared/`
(`herald/shared-prod.tfstate`). Deploy order: bootstrap `herald.tf` first (in
`centurion-ascend-web/infra/bootstrap/`), then `herald-shared`, then agents.

## Key inputs (full table: SPEC-B section 2.1)

| Variable | Default | Meaning |
|---|---|---|
| `agent` / `env` / `variant` | — / `prod` / — | Names everything `herald-<agent>-<env>` |
| `name_prefix` / `secrets_prefix` | `herald` / `herald/<agent>` | Overrides for the future cf-mandate-ops re-platform (SPEC-B section 8) |
| `secret_keys` | anthropic-key, cf-service-key, cf-anon-key | Placeholders under `herald/<agent>/` — add `leadcrm-key` for agents that read leadcrm-prod |
| `invoke_peers` / `run_task_peers` | `[]` | The ONLY way chain IAM edges come to exist |
| `session_secret_read` | `false` | Fargate only — Secrets Manager half of the session vault (per-user KMS gate is Stage 2) |
| `zip_path`, `memory_size`, `timeout` | —, 512, 120 | Lambda shape (cf-mo proven) |
| `cluster_arn`, `container_image`, `cpu`, `memory`, `max_runtime_seconds` | —, —, 1024, 4096, 2700 | Fargate shape |

## Outputs

`service_name`, `function_url`, `function_arn`, `function_name`,
`task_definition_arn`, `task_role_arn`, `exec_role_arn`, `scheduler_role_arn`,
`log_group_name`, `ecr_repo_url`, `secret_arns`, `invoke_policy_arn`,
`security_group_id`, `subnet_ids`, `assign_public_ip`.

## Non-negotiables baked in

- **Secrets never in Terraform.** `secrets.tf` creates placeholders only —
  values are seeded by `seed-herald-secrets.mjs` via the `.op-agent`
  env-injection pattern (`op://CIOS-prod/...`).
- **No semicolons in any string literal** (workstation terraform rejects them).
- IAM policies are built with `aws_iam_policy_document` / `jsonencode()` only.
- Lambda exec roles can never read `herald/sessions/*` — that grant exists only
  on fargate task roles with `session_secret_read = true`.
- Every agent may create/delete EventBridge schedules ONLY under its own
  `herald-<agent>-*` prefix, and pass ONLY its own scheduler role.

## Known deviations from SPEC-B (recorded, deliberate)

1. **Env stacks are directories, not flat files.** SPEC-B section 0 lists
   `envs/herald-vera.tf` etc. side by side, but each agent must own its own
   backend state key — Terraform backends are per-directory, so the skeletons
   are `envs/herald-<agent>/main.tf`. Same content, same naming.
2. **Spend alarms are daily prorated.** CloudWatch caps an alarm's evaluation
   window at 86400 s, so "SUM over 30 days > X" is expressed as daily
   `Sum > X/30` (per agent, and 320/30 engine-wide in herald-shared). The $400
   hard stop is in-app (SPEC-B section 6A) — alarms are advisory.
3. **`/manifest` + `/invoke` (SPEC-B section 7)** is an app-code contract for
   the agent handlers — not expressed in this module. Fargate agents publish
   their manifest to the `herald_agents` registry table (SPEC-H section 7).
