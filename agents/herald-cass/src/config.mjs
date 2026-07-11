// Static config + cold-start secret load. Secrets never on disk (SEC-3).
// Zero npm deps: @aws-sdk clients ship inside the nodejs20.x Lambda runtime and
// are imported lazily, so unit tests never touch AWS. Duplicated per agent
// (SEC-3 one-agent-one-service) - Cass carries its own copy of the envelope,
// auth, db, and model-router helpers rather than sharing a library.
export const CF_URL = process.env.CF_URL || 'https://hruwrnbrlnitytneeafv.supabase.co';
export const CF_REST = `${CF_URL}/rest/v1`;
export const CF_AUTH = `${CF_URL}/auth/v1`;
export const REGION = process.env.AWS_REGION || 'us-east-1';
export const SERVICE_ENV = process.env.SERVICE_ENV || 'prod';
export const AGENT = 'cass';
export const SERVICE = `herald-${AGENT}`;
export const SECRETS_PREFIX = process.env.SECRETS_PREFIX || `herald/${AGENT}`;
export const CAPABILITY = 'herald';

// SPEC-H section 4: Cass's only outbound edge is Nico (calendar slot -> draft).
// Inbound peers at P1: none - Cass is invoked by the dashboard (Supabase JWT) or
// by EventBridge (mode='scheduled', IAM-proven at the Function URL). LINDA joins
// ALLOWED_CALLERS later (SPEC-H section 8); that is the only line that changes.
export const ALLOWED_CALLERS = [];
export const MAX_CHAIN_DEPTH = 4;
export const NICO_FUNCTION = process.env.NICO_FUNCTION || `herald-nico-${SERVICE_ENV}`;

// Run-tier roster (locked 2026-07-10): Ashton + Jasmine only. Everyone else is
// Crawl (SPEC-I). Cass stamps the tier onto planned slots so downstream draft
// rows inherit it; it never elevates anyone.
export const RUN_PERSONS = ['ashton-couture', 'jasmine-amaso'];

// Default platforms Cass plans for a person when the fact-file / payload does
// not narrow it. Personal presence is the P1 spine; company page is planned
// only when explicitly requested (it is a shared identity, not a person's).
export const DEFAULT_PLATFORMS = ['linkedin_personal', 'x'];

// Normal weekly plans sit at 50-70% of caps (SPEC-D section 0). Cass targets the
// middle of that band; Vera still enforces the hard ceilings at act time.
export const DEFAULT_TARGET_RATIO = Number(process.env.CASS_TARGET_RATIO || 0.6);

// Engine-wide Anthropic hard cap (SPEC-B section 6A): shared across ALL herald-*
// services. Cass only spends tokens on optional theme ideation; the gate is
// checked before any model call, exactly like Nico.
export const ENGINE_BUDGET_CENTS = Number(process.env.HERALD_BUDGET_CENTS || 40000);

// Model router (mirrors cf-mandate-ops / Nico). Ideation is a cheap Sonnet task;
// Opus is reserved for a large theme brief.
export const MODEL_DEFAULT = 'claude-sonnet-5';
export const MODEL_ESCALATION = 'claude-opus-4-8';
export const MODEL_IDS = {
  'claude-sonnet-5': process.env.MODEL_ID_SONNET || 'claude-sonnet-5',
  'claude-opus-4-8': process.env.MODEL_ID_OPUS || 'claude-opus-4-8',
};
export const MODEL_PRICE = {
  'claude-sonnet-5': [3, 15],
  'claude-opus-4-8': [15, 75],
};

let _secrets = null;
export async function secrets() {
  if (_secrets) return _secrets;
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
    } catch { out[n] = ''; }
  }
  _secrets = out;
  return out;
}
export function _resetSecretsForTest() { _secrets = null; }
