// OAuth TOKEN vault: KMS-decrypted envelope parsed in memory (never disk), expiry
// flags, not-connected/invalid handling, refresh write-back, and fail-invalid
// auditing that logs a reason code only - NEVER token material.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchToken, putToken, markInvalid } from '../src/vault.mjs';
import { TOKEN_ENVELOPE, EXPIRED_TOKEN_ENVELOPE, fakeDb } from './fixtures.mjs';

test('fetchToken parses the envelope in memory: ACTIVE, author URN, not expired', async () => {
  let read = false;
  const t = await fetchToken({ secretArn: 'arn:...:herald/oauth/linkedin/ashton-couture', getSecret: async () => { read = true; return TOKEN_ENVELOPE; } });
  assert.equal(t.ok, true);
  assert.equal(t.state, 'ACTIVE');
  assert.equal(t.authorUrn, 'urn:li:person:ABC123');
  assert.equal(t.accessToken, 'SECRET-ACCESS-TOKEN');
  assert.equal(t.expired, false);
  assert.equal(read, true);
});

test('fetchToken flags an expired access token', async () => {
  const t = await fetchToken({ secretArn: 'arn', getSecret: async () => EXPIRED_TOKEN_ENVELOPE });
  assert.equal(t.ok, true);
  assert.equal(t.expired, true);
  assert.equal(t.nearingExpiry, true);
  assert.equal(t.refreshToken, 'SECRET-REFRESH-TOKEN');
});

test('missing secret (never authorized / revoked) => NOT_CONNECTED, no token', async () => {
  const t = await fetchToken({ secretArn: 'arn', getSecret: async () => { const e = new Error('gone'); e.notFound = true; throw e; } });
  assert.equal(t.ok, false);
  assert.equal(t.state, 'NOT_CONNECTED');
  assert.equal(t.reason, 'no_secret');
});

test('a malformed envelope => INVALID, never treated as a usable token', async () => {
  const t = await fetchToken({ secretArn: 'arn', getSecret: async () => 'not-json' });
  assert.equal(t.ok, false);
  assert.equal(t.state, 'INVALID');
});

test('putToken re-encrypts the updated envelope (write-back after refresh)', async () => {
  let written = null;
  await putToken({ secretArn: 'arn', envelope: { access_token: 'NEW' }, putSecret: async (arn, val) => { written = val; } });
  assert.equal(JSON.parse(written).access_token, 'NEW');
});

test('markInvalid audits a reason code only - never token material', async () => {
  const { db, calls } = fakeDb();
  const out = await markInvalid({ db, person: 'ashton-couture', secretArn: 'arn', reasonCode: 'expired_no_refresh' });
  assert.equal(out.state, 'INVALID');
  const ev = calls.events.find((e) => e.event_type === 'token.invalid');
  assert.ok(ev);
  assert.equal(ev.payload.reason, 'expired_no_refresh');
  assert.equal(JSON.stringify(ev.payload).includes('SECRET-'), false, 'no token value in the audit payload');
});
