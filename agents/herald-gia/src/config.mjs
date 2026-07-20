// Static config + cold-start secret load. Secrets never on disk (SEC-3).
// Zero npm deps: @aws-sdk clients ship inside the nodejs20.x Lambda runtime and
// are imported lazily (config.mjs, vera.mjs), so unit tests never touch AWS.
// Mirrors the settled herald-nico config; Gia is self-contained (SPEC-H 4) - its
// only outbound edge is Vera (review_content for comments + company-page posts).
export const CF_URL = process.env.CF_URL || 'https://hruwrnbrlnitytneeafv.supabase.co';
export const CF_REST = `${CF_URL}/rest/v1`;
export const CF_AUTH = `${CF_URL}/auth/v1`;
export const REGION = process.env.AWS_REGION || 'us-east-1';
export const SERVICE_ENV = process.env.SERVICE_ENV || 'prod';
export const AGENT = 'gia';
export const SERVICE = `herald-${AGENT}`;
export const SECRETS_PREFIX = process.env.SECRETS_PREFIX || `herald/${AGENT}`;
export const CAPABILITY = 'herald';

// SPEC-H section 4: the inbound peer edge into Gia is Cass (calendar/engagement
// plan -> Gia proposals). Defense-in-depth over the IAM edge - who calls me lives
// HERE + IAM, never in payload logic. Dashboard-origin calls carry a Supabase JWT.
export const ALLOWED_CALLERS = ['cass'];
export const MAX_CHAIN_DEPTH = 4;

// The single outbound edge: Gia routes comment copy + company-page drafts through
// Vera's review_content before anything is publishable (SPEC-H section 4). Target
// resolved by env for dev/staging/prod.
export const VERA_FUNCTION = process.env.VERA_FUNCTION || `herald-vera-${SERVICE_ENV}`;

// Run-tier roster (locked 2026-07-10): Ashton + Jasmine only. Everyone else is
// Crawl (SPEC-I). Tier is snapshotted onto each queue/engagement row.
export const RUN_PERSONS = ['ashton-couture', 'jasmine-amaso'];

// Engine-wide Anthropic hard cap (SPEC-B section 6A): when month-to-date spend
// across ALL herald-* services reaches $400, agents refuse model calls and
// return budget_exhausted. Stored in cents to match agent_usage.est_cost_cents.
export const ENGINE_BUDGET_CENTS = Number(process.env.HERALD_BUDGET_CENTS || 40000);

// Model router (only manage_company_page spends tokens; engage + enqueue_follow
// are deterministic). Names match the AGT-2 manifest; the actual Anthropic model
// IDs resolve from these so a model bump is a one-line config change.
export const MODEL_DEFAULT = 'claude-sonnet-5';
export const MODEL_ESCALATION = 'claude-opus-4-8';
export const MODEL_IDS = {
  'claude-sonnet-5': process.env.MODEL_ID_SONNET || 'claude-sonnet-5',
  'claude-opus-4-8': process.env.MODEL_ID_OPUS || 'claude-opus-4-8',
};
// USD per 1M tokens [input, output] - used for the ledger + budget gate only.
export const MODEL_PRICE = {
  'claude-sonnet-5': [3, 15],
  'claude-opus-4-8': [15, 75],
};

// kind/action -> platform-safety action_class (SPEC-D). Unknown actions fall
// through to a hard stop in caps.mjs (conservative: no cap = no action).
export const ACTION_CLASS = {
  like: 'like', comment: 'comment', reshare: 'reshare', reply: 'reply',
  connect: 'connect', follow: 'follow', post: 'post',
};

// SPEC-D warm-only engagement (section 1): Gia may engage ONLY with warm targets.
// A target is warm iff it carries one of these signals; anything else is a cold
// target and Gia skips it (never engages, never reserves a cap).
export const WARM_REASONS = ['connection', 'engaged_us', 'crm_partner', 'topic_graph'];

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
      out[n] = ''; // cf keys fail loud at first REST call; anthropic-key fails loud at first model call
    }
  }
  _secrets = out;
  return out;
}
export function _resetSecretsForTest() { _secrets = null; }
