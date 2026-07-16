// Static config + cold-start secret load. Secrets never on disk (SEC-3).
// Rhea is DETERMINISTIC - it assembles a branded HTML report from the queue,
// the event stream, the coverage snapshot, and the leadcrm-prod pipeline value,
// then calls herald-notify to email ceo@. No model spend. Duplicated per agent
// (SEC-3 one-agent-one-service).
export const CF_URL = process.env.CF_URL || 'https://hruwrnbrlnitytneeafv.supabase.co';
export const CF_REST = `${CF_URL}/rest/v1`;
export const CF_AUTH = `${CF_URL}/auth/v1`;
export const REGION = process.env.AWS_REGION || 'us-east-1';
export const SERVICE_ENV = process.env.SERVICE_ENV || 'prod';
export const AGENT = 'rhea';
export const SERVICE = `herald-${AGENT}`;
export const SECRETS_PREFIX = process.env.SECRETS_PREFIX || `herald/${AGENT}`;
export const CAPABILITY = 'herald';

// SPEC-H section 4: Rhea's declared outbound edge is Vera (report-claims check).
// Inbound peers: none - dashboard JWT or EventBridge (mode='scheduled', the
// Monday 07:00a CT cron). LINDA joins ALLOWED_CALLERS later (SPEC-H section 8).
export const ALLOWED_CALLERS = [];
export const MAX_CHAIN_DEPTH = 4;
export const VERA_FUNCTION = process.env.VERA_FUNCTION || `herald-vera-${SERVICE_ENV}`;

// leadcrm-prod (SPEC-F): the deal source of truth. Rhea reads the Option A
// pipeline value from here with its own service key (herald/rhea/leadcrm-key),
// the same read path shape cf-mandate-ops/deal-brain use.
export const LEADCRM_URL = process.env.LEADCRM_URL || 'https://xnmixbspbuqyyhkrskwc.supabase.co';
export const LEADCRM_REST = `${LEADCRM_URL}/rest/v1`;

// herald-notify (SPEC-G section 6): the ONE notification path. Rhea POSTs the
// composed HTML; herald-notify wraps CF's existing transactional email provider.
// Called service-to-service with the shared-secret header (cf-deal-brain pattern).
export const HERALD_NOTIFY_URL = process.env.HERALD_NOTIFY_URL || `${CF_URL}/functions/v1/herald-notify`;

// Recipient list is a constant at P1 (SPEC-G 5.2) - add Jasmine by editing this,
// not by building a preferences system.
export const REPORT_RECIPIENTS = (process.env.HERALD_REPORT_TO || 'ceo@centurionfinancial.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

// SPEC-F D2 (LOCKED Option A): capital-sought basis. Enterprise -> lending_amount,
// Funding -> amount; all open, non-won/lost. Display bands round DOWN.
export const PIPELINE_BASIS = { Enterprise: 'lending_amount', Funding: 'amount' };

let _secrets = null;
export async function secrets() {
  if (_secrets) return _secrets;
  if (process.env.CF_SERVICE_KEY) {
    _secrets = {
      'cf-service-key': process.env.CF_SERVICE_KEY,
      'cf-anon-key': process.env.CF_ANON_KEY || '',
      'leadcrm-key': process.env.LEADCRM_KEY || '',
    };
    return _secrets;
  }
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region: REGION });
  const out = {};
  for (const n of ['cf-service-key', 'cf-anon-key', 'leadcrm-key']) {
    try {
      const r = await sm.send(new GetSecretValueCommand({ SecretId: `${SECRETS_PREFIX}/${n}` }));
      out[n] = (r.SecretString || '').trim();
    } catch { out[n] = ''; }
  }
  _secrets = out;
  return out;
}
export function _resetSecretsForTest() { _secrets = null; }
