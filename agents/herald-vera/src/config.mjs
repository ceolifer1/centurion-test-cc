// Static config + cold-start secret load. Secrets never on disk (SEC-3).
// Zero npm deps: @aws-sdk/client-secrets-manager ships inside the nodejs20.x
// Lambda runtime and is imported lazily, so unit tests never touch AWS.

export const CF_URL = process.env.CF_URL || 'https://hruwrnbrlnitytneeafv.supabase.co';
export const CF_REST = `${CF_URL}/rest/v1`;
export const CF_AUTH = `${CF_URL}/auth/v1`;
export const REGION = process.env.AWS_REGION || 'us-east-1';
export const AGENT = 'vera';
export const SERVICE = `herald-${AGENT}`;
export const SECRETS_PREFIX = process.env.SECRETS_PREFIX || `herald/${AGENT}`;
export const CAPABILITY = 'herald';
// SPEC-H section 4: the only inbound peer edges into Vera (defense in depth
// over the IAM edges - who calls me lives HERE + IAM, never in payload logic).
export const ALLOWED_CALLERS = (process.env.ALLOWED_CALLERS ? process.env.ALLOWED_CALLERS.split(',').map(s => s.trim()).filter(Boolean) : ['nico', 'piper', 'rhea', 'sol', 'gia', 'cass', 'linkedin']);
export const MAX_CHAIN_DEPTH = 4;
// P1 is deterministic-only. The LLM brand/tone pass (VERA-B05 + the
// model-scored half of VERA-B03) is wired behind this flag, default OFF.
export const LLM_BRAND_PASS = process.env.VERA_LLM_BRAND_PASS === 'true';

let _secrets = null;
export async function secrets() {
  if (_secrets) return _secrets;
  // Test/local override: env-injected (op-agent pattern), never disk.
  if (process.env.CF_SERVICE_KEY) {
    _secrets = {
      'cf-service-key': process.env.CF_SERVICE_KEY,
      'cf-anon-key': process.env.CF_ANON_KEY || '',
      'anthropic-key': process.env.ANTHROPIC_KEY || '',
    };
    return _secrets;
  }
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region: REGION });
  const out = {};
  for (const n of ['cf-service-key', 'cf-anon-key', 'anthropic-key']) {
    try {
      const r = await sm.send(new GetSecretValueCommand({ SecretId: `${SECRETS_PREFIX}/${n}` }));
      out[n] = (r.SecretString || '').trim();
    } catch {
      out[n] = ''; // anthropic-key is unused in deterministic P1; cf keys fail loud at first REST call
    }
  }
  _secrets = out;
  return out;
}
export function _resetSecretsForTest() { _secrets = null; }
