// herald-gia config. COMPLIANT growth/engagement agent (Lambda, zip). Secrets
// never on disk (SEC-3). @aws-sdk clients ship in the nodejs20.x runtime and are
// imported lazily (config.mjs, vault.mjs, vera.mjs), so unit tests never touch AWS.
//
// This is the OFFICIAL-API replacement for the REJECTED browser/cookie engagement
// path (Fargate + Playwright + session cookies). Gia now engages through LinkedIn's
// versioned REST Community-Management endpoints - POST /rest/reactions and
// POST /rest/socialActions/{urn}/comments - on a 3-legged OAuth member token read
// from the SAME vault herald-linkedin writes. NO cookies, NO browser, NO feed scan.
export const CF_URL = process.env.CF_URL || 'https://hruwrnbrlnitytneeafv.supabase.co';
export const CF_REST = `${CF_URL}/rest/v1`;
export const CF_AUTH = `${CF_URL}/auth/v1`;
export const REGION = process.env.AWS_REGION || 'us-east-1';
export const SERVICE_ENV = process.env.SERVICE_ENV || 'prod';
export const AGENT = 'gia';
export const SERVICE = `herald-${AGENT}`;
export const SECRETS_PREFIX = process.env.SECRETS_PREFIX || `herald/${AGENT}`;
export const CAPABILITY = 'herald';

// SPEC-H section 4: the inbound peer edge into Gia is Cass (engagement plan ->
// Gia). Env-driven (mirrors the Vera ALLOWED_CALLERS fix) so dev/staging can add
// callers without a code change; who calls me lives HERE + IAM, never in payload
// logic. Dashboard-origin calls carry a Supabase JWT.
export const ALLOWED_CALLERS = (process.env.ALLOWED_CALLERS || 'cass').split(',').map((x) => x.trim()).filter(Boolean);
export const MAX_CHAIN_DEPTH = 4;

// Outbound peer edge: comment copy + company-page drafts route through Vera's
// review_content before anything is publishable (SPEC-H 4). Target resolved by env.
export const VERA_FUNCTION = process.env.VERA_FUNCTION || `herald-vera-${SERVICE_ENV}`;

// Run-tier roster (locked 2026-07-10): Ashton + Jasmine. Everyone else is Crawl.
export const RUN_PERSONS = (process.env.RUN_PERSONS || 'ashton-couture,jasmine-amaso').split(',').map((x) => x.trim()).filter(Boolean);

// DRY-RUN IS THE DEFAULT. Nothing hits the real LinkedIn API unless HERALD_LIVE
// is explicitly 'true'. Dry-run runs the full gauntlet (kill, warm-only, Vera,
// caps) and records what WOULD engage, but makes NO API call.
export const HERALD_LIVE = process.env.HERALD_LIVE === 'true';

// LinkedIn REST versioning + protocol headers (Reactions API + Network Update
// Social Actions API, Microsoft Learn): LinkedIn-Version: YYYYMM and
// X-Restli-Protocol-Version: 2.0.0. 202606 is the current active version.
export const LINKEDIN_VERSION = process.env.LINKEDIN_VERSION || '202606';
export const LINKEDIN_API_BASE = process.env.LINKEDIN_API_BASE || 'https://api.linkedin.com';

// OAuth token vault (KMS-CMK-encrypted Secrets Manager) - the SAME per-person
// envelope herald-linkedin writes at herald/oauth/linkedin/<person>. Gia is a
// READER of this vault (never a writer/refresher - refresh is herald-linkedin's
// job). Token VALUES never leave this process, never logged (SPEC-C T3).
export const OAUTH_VAULT_PREFIX = process.env.OAUTH_VAULT_PREFIX || 'herald/oauth/linkedin';
export const oauthSecretName = (person) => `${OAUTH_VAULT_PREFIX}/${person}`;
export const REFRESH_SKEW_SECONDS = Number(process.env.REFRESH_SKEW_SECONDS || 7 * 24 * 3600);

// APPROVAL GATE. Creating a reaction/comment on an arbitrary member target via the
// versioned /rest endpoints requires the Community Management API scope
// w_member_social_feed (Microsoft Learn: Reactions API + Network Update Social
// Actions permission tables both list w_member_social_feed for member create). That
// scope belongs to the Community Management API - a Vetted Product (Development +
// Standard tiers, LinkedIn review). The w_member_social scope herald-linkedin holds
// authors posts (/rest/posts) but does NOT grant social-action create. Live
// engagement is therefore gated on BOTH HERALD_LIVE and the vaulted token carrying
// this scope; without it Gia refuses the API call and records a would-engage.
export const ENGAGE_REQUIRED_SCOPE = process.env.ENGAGE_REQUIRED_SCOPE || 'w_member_social_feed';

// Company-page path (author = urn:li:organization, w_organization_social_feed)
// stays queue-only until the Community Management API is approved for the app.
export const ORG_ENABLED = process.env.LINKEDIN_ORG_ENABLED === 'true';

// Engine-wide Anthropic hard cap (SPEC-B 6A): month-to-date spend across ALL
// herald-* services >= $400 => refuse model calls (budget_exhausted). Cents.
export const ENGINE_BUDGET_CENTS = Number(process.env.HERALD_BUDGET_CENTS || 40000);

// Model router (only manage_company_page spends tokens; engage + enqueue_follow
// are deterministic). Names match the AGT-2 manifest.
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

// action/kind -> SPEC-D action_class. A reaction ("like"/"react"/"reaction")
// consumes the 'like' cap; a comment consumes the 'comment' cap. Unknown actions
// fall through to a hard stop in caps.mjs (conservative: no cap = no action).
export const ACTION_CLASS = {
  like: 'like', react: 'like', reaction: 'like',
  comment: 'comment', reply: 'reply', reshare: 'reshare',
  connect: 'connect', follow: 'follow', post: 'post',
};

// LinkedIn reaction types (Reactions API schema, Microsoft Learn). MAYBE is
// deprecated (400 on create) and intentionally omitted.
export const REACTION_TYPES = ['LIKE', 'PRAISE', 'EMPATHY', 'INTEREST', 'APPRECIATION', 'ENTERTAINMENT'];
export const DEFAULT_REACTION = 'LIKE';

// SPEC-D warm-only engagement (section 1): Gia may engage ONLY warm/curated
// targets. Anything else is cold and Gia skips it (never engages, never reserves).
export const WARM_REASONS = ['curated', 'connection', 'engaged_us', 'crm_partner', 'topic_graph'];

// Kill-switch cache TTL (SPEC-H 5.2) - 60s max, in memory only.
export const KILL_CACHE_TTL_MS = 60_000;

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
    } catch { out[n] = ''; }
  }
  _secrets = out;
  return out;
}
export function _resetSecretsForTest() { _secrets = null; }
