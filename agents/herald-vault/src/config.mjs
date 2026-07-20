// herald-vault config (SPEC-C). Secrets never on disk (SEC-3). Zero npm deps:
// @aws-sdk clients ship in the nodejs20.x Lambda runtime and are imported lazily
// in store.mjs, so unit tests never touch AWS. The vault LAMBDA holds NO
// kms:Decrypt / GetSecretValue on session cookies - only the capture fargate role
// encrypts+stores, and only per-user agent task roles decrypt at runtime. This
// module owns the naming that ties the three planes together.
export const CF_URL = process.env.CF_URL || 'https://hruwrnbrlnitytneeafv.supabase.co';
export const CF_REST = `${CF_URL}/rest/v1`;
export const CF_AUTH = `${CF_URL}/auth/v1`;
export const REGION = process.env.AWS_REGION || 'us-east-1';
export const SERVICE_ENV = process.env.SERVICE_ENV || 'prod';
export const AGENT = 'vault';
export const SERVICE = `herald-${AGENT}`;
export const SECRETS_PREFIX = process.env.SECRETS_PREFIX || `herald/${AGENT}`;
export const CAPABILITY = 'herald';

// Dashboard-origin calls carry a Supabase JWT. There is no peer that invokes the
// vault - capture/consent/revoke are dashboard-driven (SPEC-C 3). Kept empty so
// the only non-JWT caller path is closed.
export const ALLOWED_CALLERS = [];
export const MAX_CHAIN_DEPTH = 4;

// Platforms that get a standing vaulted session at P0 (SPEC-C 1). Google
// Business / Crunchbase / The Org / Wikidata ride APIs or short-lived sessions.
export const SESSION_PLATFORMS = ['linkedin_personal', 'linkedin_company', 'x'];

// The three naming planes (SPEC-C 4). person = fact-file id (matches Piper's
// runtime session path); platform = the platform enum.
//   secret : herald/sessions/<person>/<platform>   (Secrets Manager)
//   key    : alias/herald/user/<person>            (per-person CMK, KMS)
export const sessionSecretName = (person, platform) => `herald/sessions/${person}/${platform}`;
export const userKeyAlias = (person) => `alias/herald/user/${person}`;

// The ephemeral capture task (SPEC-C 3) + the browser cluster (revoke StopTask).
export const CAPTURE_TASKDEF = process.env.HERALD_CAPTURE_TASKDEF || `herald-vault-capture-${SERVICE_ENV}`;
export const BROWSER_CLUSTER = process.env.HERALD_BROWSER_CLUSTER || `herald-browser-${SERVICE_ENV}`;
export const CAPTURE_MAX_SECONDS = Number(process.env.CAPTURE_MAX_SECONDS || 900); // 15 min hard cap (SPEC-C 3.5)

let _secrets = null;
export async function secrets() {
  if (_secrets) return _secrets;
  if (process.env.CF_SERVICE_KEY) {
    _secrets = { 'cf-service-key': process.env.CF_SERVICE_KEY, 'cf-anon-key': process.env.CF_ANON_KEY || '' };
    return _secrets;
  }
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region: REGION });
  const out = {};
  for (const n of ['cf-service-key', 'cf-anon-key']) {
    try {
      const r = await sm.send(new GetSecretValueCommand({ SecretId: `${SECRETS_PREFIX}/${n}` }));
      out[n] = (r.SecretString || '').trim();
    } catch { out[n] = ''; }
  }
  _secrets = out;
  return out;
}
export function _resetSecretsForTest() { _secrets = null; }
