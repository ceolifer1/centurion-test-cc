// OAuth TOKEN vault - the KMS approach from the retired cookie work, repurposed
// for LinkedIn OAuth tokens (NOT cookies). The per-person envelope lives in
// Secrets Manager at herald/oauth/linkedin/<person>, encrypted with the
// alias/herald/oauth/linkedin CMK. GetSecretValue triggers kms:Decrypt under
// that CMK; the plaintext lives only in this function's scope and is NEVER
// written to disk or logged (SPEC-C T3 - only counts, expiry, and reason codes).
import { REGION, REFRESH_SKEW_SECONDS } from './config.mjs';

// Fetch + decrypt the per-person token envelope at runtime. A missing secret
// (never captured / revoked) surfaces as NOT_CONNECTED - publish then stops
// (no token = no post, never a login attempt).
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
    refreshToken: env.refresh_token || null,
    authorUrn: env.author_urn || null,
    scope: env.scope || null,
    expiresAt,
    expired: expiresAt > 0 && expiresAt <= nowSec,
    nearingExpiry: expiresAt > 0 && (expiresAt - nowSec) <= REFRESH_SKEW_SECONDS,
  };
  raw = null; env = null; // best-effort zeroize of the parsed plaintext
  return result;
}

// Write an updated envelope back to the vault (after a refresh). PutSecretValue
// re-encrypts under the CMK. Token values never logged.
export async function putToken({ secretArn, envelope, putSecret, region = REGION }) {
  const put = putSecret || (await defaultPutSecret(region));
  await put(secretArn, JSON.stringify(envelope));
  return { ok: true };
}

// Mark a token invalid (audit reason code only - never token material) and STOP.
// There is no re-login path; re-consent is the only recovery (Ashton re-runs the
// one-time capture). Mirrors the fail-invalid discipline of the session vault.
export async function markInvalid({ db, person, secretArn, reasonCode = 'token_invalid' }) {
  await db.insertEvent({ agent: 'linkedin', person, event_type: 'token.invalid',
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
async function defaultPutSecret(region) {
  const { SecretsManagerClient, PutSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region });
  return async (arn, value) => sm.send(new PutSecretValueCommand({ SecretId: arn, SecretString: value }));
}
