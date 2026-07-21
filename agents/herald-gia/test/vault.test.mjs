// OAuth TOKEN vault reader: KMS-decrypted envelope parsed in memory (never disk),
// scope presence, expiry flags, not-connected/invalid handling, and fail-invalid
// auditing that logs a reason code only - NEVER token material.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './fixtures.mjs';
import { fetchToken, markInvalid, scopeHas } from '../src/vault.mjs';
import { TOKEN_FEED, TOKEN_NOFEED, TOKEN_EXPIRED, fakeDb } from './fixtures.mjs';

test('scopeHas detects w_member_social_feed and does NOT false-match on w_member_social', () => {
  assert.equal(scopeHas('w_member_social w_member_social_feed openid', 'w_member_social_feed'), true);
  assert.equal(scopeHas('w_member_social openid profile', 'w_member_social_feed'), false);
});

test('fetchToken parses the FEED envelope: ACTIVE, actor URN, scope carries w_member_social_feed', async () => {
  const t = await fetchToken({ secretArn: 'arn:...:herald/oauth/linkedin/ashton-couture', getSecret: async () => TOKEN_FEED });
  assert.equal(t.ok, true);
  assert.equal(t.state, 'ACTIVE');
  assert.equal(t.authorUrn, 'urn:li:person:ABC123');
  assert.equal(t.accessToken, 'SECRET-ACCESS-TOKEN');
  assert.equal(t.expired, false);
  assert.equal(scopeHas(t.scope, 'w_member_social_feed'), true);
});

test('fetchToken on the NOFEED envelope is ACTIVE but lacks the engagement scope', async () => {
  const t = await fetchToken({ secretArn: 'arn', getSecret: async () => TOKEN_NOFEED });
  assert.equal(t.ok, true);
  assert.equal(scopeHas(t.scope, 'w_member_social_feed'), false);
});

test('fetchToken flags an expired access token', async () => {
  const t = await fetchToken({ secretArn: 'arn', getSecret: async () => TOKEN_EXPIRED });
  assert.equal(t.ok, true);
  assert.equal(t.expired, true);
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

test('markInvalid audits a reason code only - never token material', async () => {
  const { db, calls } = fakeDb();
  const out = await markInvalid({ db, person: 'ashton-couture', reasonCode: 'no_secret' });
  assert.equal(out.state, 'INVALID');
  const ev = calls.events.find((e) => e.event_type === 'token.invalid');
  assert.ok(ev);
  assert.equal(ev.payload.reason, 'no_secret');
  assert.equal(JSON.stringify(ev.payload).includes('SECRET-'), false, 'no token value in the audit payload');
});
