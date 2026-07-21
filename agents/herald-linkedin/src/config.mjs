// herald-linkedin config. COMPLIANT LinkedIn publisher (Lambda, zip). Secrets
// never on disk (SEC-3). @aws-sdk clients ship in the nodejs20.x runtime and are
// imported lazily (config.mjs, vault.mjs), so unit tests never touch AWS.
//
// This agent is the OFFICIAL-API replacement for the browser/cookie publisher:
// it posts through LinkedIn's REST /rest/posts endpoint on a 3-legged OAuth
// member token (w_member_social) - no session cookies, no Playwright.
export const CF_URL = process.env.CF_URL || 'https://hruwrnbrlnitytneeafv.supabase.co';
export const CF_REST = `${CF_URL}/rest/v1`;
export const CF_AUTH = `${CF_URL}/auth/v1`;
export const REGION = process.env.AWS_REGION || 'us-east-1';
export const SERVICE_ENV = process.env.SERVICE_ENV || 'prod';
export const AGENT = 'linkedin';
export const SERVICE = `herald-${AGENT}`;
export const SECRETS_PREFIX = process.env.SECRETS_PREFIX || `herald/${AGENT}`;
export const CAPABILITY = 'herald';

// Completion/verify peer edge: linkedin -> Vera review_content on the EXACT final
// text before any post (SPEC-H section 4 - the Vera gate is never skipped).
export const VERA_FUNCTION = process.env.VERA_FUNCTION || `herald-vera-${SERVICE_ENV}`;
export const ALLOWED_CALLERS = (process.env.ALLOWED_CALLERS || 'cass').split(',').map((x) => x.trim()).filter(Boolean);
export const MAX_CHAIN_DEPTH = 4;

// DRY-RUN IS THE DEFAULT. Nothing hits the real LinkedIn API unless HERALD_LIVE
// is explicitly 'true'. Dry-run runs the full gauntlet (kill, Vera re-verify,
// caps) and records what WOULD post, but makes NO API call.
export const HERALD_LIVE = process.env.HERALD_LIVE === 'true';

// LinkedIn REST versioning + protocol headers (Posts API doc, Microsoft Learn):
//   LinkedIn-Version: YYYYMM  and  X-Restli-Protocol-Version: 2.0.0
export const LINKEDIN_VERSION = process.env.LINKEDIN_VERSION || '202506';
export const LINKEDIN_API_BASE = process.env.LINKEDIN_API_BASE || 'https://api.linkedin.com';
export const LINKEDIN_OAUTH_BASE = process.env.LINKEDIN_OAUTH_BASE || 'https://www.linkedin.com';

// OAuth token vault (KMS-CMK-encrypted Secrets Manager). person resolves the ARN
// at runtime; the envelope holds { access_token, refresh_token, expires_at,
// scope, author_urn }. Token VALUES never leave this process, never logged.
export const OAUTH_VAULT_PREFIX = process.env.OAUTH_VAULT_PREFIX || 'herald/oauth/linkedin';
export const oauthSecretName = (person) => `${OAUTH_VAULT_PREFIX}/${person}`;

// Refresh access tokens this many seconds before expiry (LinkedIn access tokens
// live ~60 days; refresh tokens longer). refresh_tokens() sweeps this window.
export const REFRESH_SKEW_SECONDS = Number(process.env.REFRESH_SKEW_SECONDS || 7 * 24 * 3600);

// Company-page path (author = urn:li:organization:{id}, scope w_organization_social)
// stays OFF until LinkedIn approves the Community Management API for the app.
export const ORG_ENABLED = process.env.LINKEDIN_ORG_ENABLED === 'true';
export const ORG_ID = process.env.LINKEDIN_ORG_ID || '';

// Roster refresh_tokens() sweeps (avoids secretsmanager:ListSecrets - we only
// ever touch our own known people's vault paths).
export const REFRESH_PERSONS = (process.env.REFRESH_PERSONS || 'ashton-couture').split(',').map((x) => x.trim()).filter(Boolean);

// Kill-switch cache TTL (SPEC-H 5.2) - 60s max, in memory only.
export const KILL_CACHE_TTL_MS = 60_000;

// kind -> SPEC-D action_class. Unknown kinds hard-stop in caps.mjs (no cap = no action).
export const ACTION_CLASS = {
  post: 'post', thread: 'post', tombstone: 'post', profile_update: 'post',
  comment: 'comment', reshare: 'reshare', reply: 'reply',
};

let _secrets = null;
export async function secrets() {
  if (_secrets) return _secrets;
  // Test/local override: env-injected (op-agent pattern), never disk.
  if (process.env.CF_SERVICE_KEY) {
    _secrets = {
      'cf-service-key': process.env.CF_SERVICE_KEY,
      'cf-anon-key': process.env.CF_ANON_KEY || '',
      'client-id': process.env.LINKEDIN_CLIENT_ID || '',
      'client-secret': process.env.LINKEDIN_CLIENT_SECRET || '',
    };
    return _secrets;
  }
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region: REGION });
  const out = {};
  for (const n of ['cf-service-key', 'cf-anon-key', 'client-id', 'client-secret']) {
    try {
      const r = await sm.send(new GetSecretValueCommand({ SecretId: `${SECRETS_PREFIX}/${n}` }));
      out[n] = (r.SecretString || '').trim();
    } catch { out[n] = ''; }
  }
  _secrets = out;
  return out;
}
export function _resetSecretsForTest() { _secrets = null; }
