// SPEC-C session vault - the RUNTIME half (capture is dashboard-driven, Stage 3).
// Rules implemented verbatim: memory-only (cookies never touch disk), runtime
// injection into the Playwright context, fail-invalid-never-relogin, and the
// section 6.1 state machine that Piper honors. Cookie VALUES are never logged
// (SPEC-C T3) - only counts and reason codes.
import { REGION } from './config.mjs';

export const SESSION_STATES = ['NOT_CONNECTED', 'PENDING_CONSENT', 'ACTIVE', 'INVALID', 'REVOKED'];

// SPEC-C 6.1 state table. REVOKED is a terminal event that resolves to
// NOT_CONNECTED (secret deleted, no recovery) - modeled as its own node here so
// the transition is explicit and auditable.
const TRANSITIONS = {
  NOT_CONNECTED: { consent_open: 'PENDING_CONSENT' },
  PENDING_CONSENT: { capture_success: 'ACTIVE', consent_timeout: 'NOT_CONNECTED' },
  ACTIVE: { refresh_success: 'ACTIVE', probe_logged_out: 'INVALID', checkpoint: 'INVALID', revoke: 'REVOKED', expire_45d: 'REVOKED' },
  INVALID: { reconsent: 'ACTIVE', revoke: 'REVOKED', expire_45d: 'REVOKED' },
  REVOKED: {},
};
export function nextSessionState(state, event) {
  const to = TRANSITIONS[state]?.[event];
  if (!to) throw new Error(`illegal session transition: ${state} --${event}-->`);
  return to;
}

// Fetch + decrypt the per-user session envelope at runtime. GetSecretValue
// triggers kms:Decrypt under the per-user CMK (SPEC-C 4.1). The plaintext lives
// only in this function's scope; nothing is written to disk. A deleted secret
// (revoke/expiry/45-day) surfaces as state NOT_CONNECTED.
export async function fetchSession({ secretArn, getSecret, region = REGION }) {
  const get = getSecret || (await defaultGetSecret(region));
  let raw;
  try { raw = await get(secretArn); }
  catch (e) {
    return { ok: false, state: 'NOT_CONNECTED', reason: e?.notFound ? 'no_secret' : 'decrypt_failed' };
  }
  if (!raw) return { ok: false, state: 'NOT_CONNECTED', reason: 'no_secret' };
  let env;
  try { env = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return { ok: false, state: 'INVALID', reason: 'bad_envelope' }; }
  const cookies = Array.isArray(env.cookies) ? env.cookies : [];
  if (cookies.length === 0) return { ok: false, state: 'INVALID', reason: 'no_cookies' };
  const fingerprint = { userAgent: env.userAgent || null, viewport: env.viewport || null };
  const result = { ok: true, state: 'ACTIVE', cookies, fingerprint, cookieCount: cookies.length,
    capturedAt: env.capturedAt || null, consentRowId: env.consentRowId || null };
  raw = null; env = null; // best-effort zeroize of the parsed plaintext
  return result;
}

// Load cookies straight into the Playwright browser context IN MEMORY. Never
// writes a storageState file, never touches the container filesystem (SPEC-C
// 5.1 step 3). Returns the count injected (for the audit event - a number, not
// the cookies).
export async function injectCookies(context, cookies) {
  if (!context || typeof context.addCookies !== 'function') throw new Error('injectCookies: a Playwright context is required');
  await context.addCookies(cookies);
  return cookies.length;
}

// Fail-invalid: mark the session INVALID and STOP. HERALD never attempts a
// username/password login (SPEC-C 5.3 / SPEC-D section 1). Only a reason code is
// audited - never page content that could embed a token.
export async function markInvalid({ db, person, platform, secretArn, reasonCode = 'logged_out', setLabel, region = REGION }) {
  await db.insertEvent({ agent: 'piper', person, event_type: 'session.invalid',
    payload: { platform, reason: reasonCode } }).catch(() => {});
  if (secretArn) {
    try {
      const label = setLabel || (await defaultSetLabel(region));
      await label(secretArn, 'INVALID');
    } catch { /* best-effort marker - the run stops regardless (fail-invalid) */ }
  }
  return { state: 'INVALID', reason: reasonCode };
}

async function defaultGetSecret(region) {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region });
  return async (arn) => {
    try {
      const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
      return r.SecretString || null;
    } catch (e) {
      if (e?.name === 'ResourceNotFoundException') { e.notFound = true; }
      throw e;
    }
  };
}
async function defaultSetLabel(region) {
  const { SecretsManagerClient, TagResourceCommand } = await import('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region });
  return async (arn, value) => sm.send(new TagResourceCommand({ SecretId: arn, Tags: [{ Key: 'herald:state', Value: value }] }));
}
