// OAuth TOKEN vault READER. Gia reads the SAME per-person token envelope
// herald-linkedin writes at herald/oauth/linkedin/<person> (Secrets Manager,
// encrypted with the alias/herald/oauth/linkedin CMK). GetSecretValue triggers
// kms:Decrypt under that CMK; the plaintext lives only in this function's scope
// and is NEVER written to disk or logged (SPEC-C T3 - only counts, expiry, scope
// PRESENCE, and reason codes). Gia NEVER writes/refreshes the token - refresh is
// herald-linkedin's job; an expired token here just stops the engagement.
import { REGION, REFRESH_SKEW_SECONDS } from './config.mjs';

// True iff the space/comma-separated scope string contains the exact scope. Used
// to enforce the Community-Management approval gate (w_member_social_feed) before
// any live reaction/comment - never to log or echo token material.
export function scopeHas(scope, needed) {
  const esc = String(needed).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,])${esc}([\\s,]|$)`).test(String(scope || ''));
}

// Fetch + decrypt the per-person token envelope at runtime. A missing secret
// (never captured / revoked) surfaces as NOT_CONNECTED - engagement then stops
// (no token = no action, never a login attempt).
export async function fetchToken({ secretArn, getSecret, region = REGION }) {
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
  if (!env.access_token) return { ok: false, state: 'INVALID', reason: 'no_access_token' };
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = Number(env.expires_at || 0);
  const result = {
    ok: true, state: 'ACTIVE',
    accessToken: env.access_token,
    authorUrn: env.author_urn || null,
    scope: env.scope || '',
    expiresAt,
    expired: expiresAt > 0 && expiresAt <= nowSec,
    nearingExpiry: expiresAt > 0 && (expiresAt - nowSec) <= REFRESH_SKEW_SECONDS,
  };
  raw = null; env = null; // best-effort zeroize of the parsed plaintext
  return result;
}

// Mark a token invalid (audit reason code only - never token material) and STOP.
// There is no re-login path; re-consent is the only recovery (Ashton re-runs the
// one-time capture that herald-linkedin owns).
export async function markInvalid({ db, person, reasonCode = 'token_invalid' }) {
  await db.insertEvent({ agent: 'gia', person, event_type: 'token.invalid',
    payload: { platform: 'linkedin_personal', reason: reasonCode } }).catch(() => {});
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
