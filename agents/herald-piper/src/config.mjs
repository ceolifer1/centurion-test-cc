// herald-piper config. Fargate/Playwright publisher. Secrets never on disk
// (SEC-3 / SPEC-C): the agent's OWN config secrets (cf-service-key, anthropic
// unused) come from herald/piper/*; the per-user SESSION secret is fetched at
// RUNTIME from herald/sessions/<person>/<platform> (KMS-gated) and lives in
// memory only (vault.mjs). Unlike the Lambda agents, the Playwright base image
// does not ship the aws-sdk, so @aws-sdk/* are real deps here (package.json),
// imported lazily so unit tests run with zero installed deps.
export const CF_URL = process.env.CF_URL || 'https://hruwrnbrlnitytneeafv.supabase.co';
export const CF_REST = `${CF_URL}/rest/v1`;
export const REGION = process.env.AWS_REGION || 'us-east-1';
export const SERVICE_ENV = process.env.SERVICE_ENV || 'prod';
export const AGENT = 'piper';
export const SERVICE = `herald-${AGENT}`;
export const SECRETS_PREFIX = process.env.SECRETS_PREFIX || `herald/${AGENT}`;

// Completion callback edge Piper -> Vera confirm_posted (SPEC-H 4 step 9).
export const VERA_FUNCTION = process.env.VERA_FUNCTION || `herald-vera-${SERVICE_ENV}`;

// DRY-RUN IS THE DEFAULT (P1 Build Plan section 4 / SPEC-C section 9). Nothing
// reaches a real profile unless HERALD_LIVE is explicitly 'true'. Dry-run posts
// to a private/test surface and records what WOULD post.
export const DRY_RUN = process.env.HERALD_LIVE !== 'true';
export const TEST_SURFACE = process.env.HERALD_TEST_SURFACE || 'mock://piper-dryrun';

// Two independent runtime walls (SPEC-B 4.5). The in-container watchdog uses this.
export const MAX_RUNTIME_SECONDS = Number(process.env.MAX_RUNTIME_SECONDS || 2700);

// Kill-switch cache TTL (SPEC-H 5.2) - 60s max, in memory only.
export const KILL_CACHE_TTL_MS = 60_000;

// Per-user session secret path (SPEC-B section 1 / SPEC-C 4.2). person + platform
// resolve the ARN at runtime; the ARN (never the value) arrives in the run payload.
export const sessionSecretName = (person, platform) => `herald/sessions/${person}/${platform}`;

// kind -> platform-safety action_class (SPEC-D). Unknown kinds fall through to a
// hard stop in caps.mjs (conservative: no cap = no action).
export const ACTION_CLASS = {
  post: 'post', thread: 'post', tombstone: 'post', profile_update: 'post',
  comment: 'comment', reshare: 'reshare',
};

let _secrets = null;
export async function secrets() {
  if (_secrets) return _secrets;
  if (process.env.CF_SERVICE_KEY) { _secrets = { 'cf-service-key': process.env.CF_SERVICE_KEY }; return _secrets; }
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region: REGION });
  const out = {};
  for (const n of ['cf-service-key']) {
    try {
      const r = await sm.send(new GetSecretValueCommand({ SecretId: `${SECRETS_PREFIX}/${n}` }));
      out[n] = (r.SecretString || '').trim();
    } catch { out[n] = ''; }
  }
  _secrets = out;
  return out;
}
export function _resetSecretsForTest() { _secrets = null; }
