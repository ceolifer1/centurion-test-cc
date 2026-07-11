// Static config + cold-start secret load. Secrets never on disk (SEC-3).
// Sol is DETERMINISTIC - it generates data (JSON-LD, coverage snapshots, SERP
// scorecards, Knowledge-Panel claim payloads) and never spends model tokens and
// never publishes. Duplicated per agent (SEC-3 one-agent-one-service).
export const CF_URL = process.env.CF_URL || 'https://hruwrnbrlnitytneeafv.supabase.co';
export const CF_REST = `${CF_URL}/rest/v1`;
export const CF_AUTH = `${CF_URL}/auth/v1`;
export const REGION = process.env.AWS_REGION || 'us-east-1';
export const SERVICE_ENV = process.env.SERVICE_ENV || 'prod';
export const AGENT = 'sol';
export const SERVICE = `herald-${AGENT}`;
export const SECRETS_PREFIX = process.env.SECRETS_PREFIX || `herald/${AGENT}`;
export const CAPABILITY = 'herald';

// SPEC-H section 4: Sol's declared outbound edge is Vera (panel-content checks).
// At P1 Sol only GENERATES data (no publish, no submit), so it holds the edge
// but does not exercise it. Inbound peers: none - dashboard JWT or EventBridge
// (mode='scheduled') only. LINDA joins ALLOWED_CALLERS later (SPEC-H section 8).
export const ALLOWED_CALLERS = [];
export const MAX_CHAIN_DEPTH = 4;
export const VERA_FUNCTION = process.env.VERA_FUNCTION || `herald-vera-${SERVICE_ENV}`;

// The Centurion organization entity (schema.org / Wikidata seed anchor). Values
// are fact-base-locked: founded 2021, Houston, never "AUM"/"raised".
export const ORG = {
  key: 'centurion-financial',
  name: 'Centurion Financial',
  legalName: 'Centurion Financial',
  foundingDate: '2021',
  url: 'https://centurionfinancial.com',
  addressLocality: 'Houston',
  addressRegion: 'TX',
  addressCountry: 'US',
  sameAs: [
    'https://centurionfinancial.com',
    'https://www.crunchbase.com/organization/centurion-financial',
  ],
};

// KYC-coverage platform set (SPEC-F: Sol coverage feeds the scorecard; screen 05).
// Order = display order on the scorecard.
export const TRACKED_PLATFORMS = [
  'linkedin_personal', 'x', 'google_business', 'crunchbase', 'the_org', 'wikidata', 'entity_home',
];

// Map an approved_link `kind` (fact-file) onto a tracked platform.
export const LINK_KIND_TO_PLATFORM = {
  linkedin: 'linkedin_personal',
  x: 'x',
  twitter: 'x',
  crunchbase: 'crunchbase',
  the_org: 'the_org',
  theorg: 'the_org',
  wikidata: 'wikidata',
  google_business: 'google_business',
  gbp: 'google_business',
  site: 'entity_home',
  entity_home: 'entity_home',
};

// The P1 roster (SPEC-I): Ashton + Jasmine (Run) + Stephen + Anwar (Crawl). Used
// as the default coverage roster when the caller does not narrow it; coverage
// always reads the live fact-files, this is only the ordering / fallback set.
export const ROSTER = ['ashton-couture', 'jasmine-amaso', 'stephen-warren', 'anwar-ferguson'];

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
