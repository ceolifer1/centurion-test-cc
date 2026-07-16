# herald-piper infra expectations (Stage 2 verification)

Purpose: record what the Piper Fargate stack (`infra/envs/herald-piper/main.tf`,
authored at Stage 0 from SPEC-B) MUST provide for the Stage 2 container, and note
any drift found while building the agent. **Nothing here is applied** — Stage 2
is code + tests only; AWS deploy is gated on Ashton's key.

## Verified consistent with SPEC-B section 4 + the agent code

| Expectation (SPEC-B / SPEC-C) | Stack today | Agent code relies on it |
|---|---|---|
| Fargate variant, shared cluster | `variant = "fargate"`, `cluster_arn` from `herald-shared` | RunTask-only (no ECS service) |
| Task role may read the session vault | `session_secret_read = true` | `vault.fetchSession` GetSecretValue on `herald/sessions/<person>/<platform>` |
| Completion callback edge to Vera | `invoke_peers = ["vera"]` | `vera.confirmPosted` (lambda:InvokeFunction on herald-vera-prod) |
| No inbound ports; egress-only | module SG: zero ingress, egress 443/80 | Piper originates traffic only |
| Default-VPC public-IP posture | `assign_public_ip = true`, default subnets | accepted until CIOS gateway |
| Container image from shared repo | `herald-browser:piper-latest` | image built from `agents/herald-piper/Dockerfile` |
| Session material NOT injected at container start | no `secrets` block for session; runtime fetch | SPEC-C: revoke takes effect next run, zero redeploy |

## Runtime contract the container expects (RunTask override env)

- `RUN_ID` — herald_runs id (envelope runId).
- `CONTENT_ID` (or `PAYLOAD_REF`) — herald_content_queue id to publish.
- `SECRETS_PREFIX=herald/piper`, `SERVICE_ENV`, `AGENT_NAME`, `ENGINE=herald`,
  `MAX_RUNTIME_SECONDS`, `CLUSTER_ARN` (SPEC-B 4.2).
- `HERALD_LIVE` — absent/`false` = DRY-RUN (default, nowhere real); `true` = live
  (requires a wired live poster, which Stage 2 does NOT ship).
- `STOP_SCHEDULE_NAME` (optional) — the one-shot StopTask schedule the task
  deletes itself on clean exit (SPEC-B 4.5 backstop).

## Drift / follow-ups for the deploy step (do NOT apply now)

1. **Image tag.** The stack's `container_image` default pins `:piper-latest`, but
   `scripts/build-image.sh` tags `:piper-<version>` (currently `piper-1.0.0`).
   At deploy, either push a `piper-latest` tag as well or set
   `-var container_image=...:piper-1.0.0`. No code change; a deploy-var choice.
2. **Ephemeral storage.** Module default `ephemeral_storage_gib = 30`. SPEC-C 5.1
   wants ephemeral at the practical minimum (cookies live in memory, browser
   profile in tmpfs). 20-21 GiB is the Fargate floor; consider setting
   `ephemeral_storage_gib` down at the instance if the image fits. Not a
   correctness issue — nothing is written to that disk by design.
3. **Per-user KMS gate is Stage-3 wiring.** `session_secret_read = true` grants
   only the Secrets Manager half; the per-user CMK (`herald-user-<uuid>`) and its
   key policy are created by the dashboard consent/capture flow (Stage 3). Until
   then Piper can list/read the session-secret ARN but decryption has no key —
   which is exactly the SPEC-B section 9 acceptance note ("test at Stage 2").
4. **Rate counters live in Supabase, not DynamoDB.** SPEC-D 7.1 offered either;
   this build chose the CF-prod `herald_rate_counters` table + RPCs (migration
   0003) to avoid new infra — so NO DynamoDB table is needed in this stack.
