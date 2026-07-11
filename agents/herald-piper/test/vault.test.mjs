// SPEC-C vault: state machine, runtime inject (memory only - never disk), and
// fail-invalid marking (no cookie values logged, no relogin path exists).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSessionState, fetchSession, injectCookies, markInvalid } from '../src/vault.mjs';
import { SESSION_ENVELOPE, fakeDb } from './fixtures.mjs';

test('state machine follows SPEC-C 6.1 transitions', () => {
  assert.equal(nextSessionState('NOT_CONNECTED', 'consent_open'), 'PENDING_CONSENT');
  assert.equal(nextSessionState('PENDING_CONSENT', 'capture_success'), 'ACTIVE');
  assert.equal(nextSessionState('ACTIVE', 'refresh_success'), 'ACTIVE');
  assert.equal(nextSessionState('ACTIVE', 'probe_logged_out'), 'INVALID');
  assert.equal(nextSessionState('ACTIVE', 'checkpoint'), 'INVALID');
  assert.equal(nextSessionState('INVALID', 'reconsent'), 'ACTIVE');
  assert.equal(nextSessionState('ACTIVE', 'revoke'), 'REVOKED');
  assert.equal(nextSessionState('INVALID', 'expire_45d'), 'REVOKED');
});

test('illegal transitions throw (e.g. NOT_CONNECTED cannot capture directly)', () => {
  assert.throws(() => nextSessionState('NOT_CONNECTED', 'capture_success'), /illegal session transition/);
  assert.throws(() => nextSessionState('REVOKED', 'reconsent'), /illegal/);
});

test('fetchSession parses the envelope in memory and never touches disk', async () => {
  let secretRead = false;
  const sess = await fetchSession({ secretArn: 'arn:...:herald/sessions/ashton-couture/linkedin',
    getSecret: async () => { secretRead = true; return SESSION_ENVELOPE; } });
  assert.equal(sess.ok, true);
  assert.equal(sess.state, 'ACTIVE');
  assert.equal(sess.cookieCount, 2);
  assert.equal(sess.fingerprint.userAgent, 'Mozilla/5.0 (captured fingerprint)');
  assert.deepEqual(sess.fingerprint.viewport, { width: 1280, height: 800 });
  assert.equal(secretRead, true);
});

test('injectCookies loads straight into the Playwright context (no storageState file)', async () => {
  let injected = null;
  const context = { addCookies: async (c) => { injected = c; } };
  const n = await injectCookies(context, [{ name: 'li_at', value: 'x', domain: '.linkedin.com', path: '/' }]);
  assert.equal(n, 1);
  assert.equal(injected[0].name, 'li_at');
  // No fs/storageState surface exists on the code path - the only sink is the
  // in-memory context.addCookies. A missing context is a hard error.
  await assert.rejects(() => injectCookies(null, []), /Playwright context is required/);
});

test('deleted secret (revoke/expiry) -> NOT_CONNECTED, no cookies', async () => {
  const sess = await fetchSession({ secretArn: 'arn', getSecret: async () => { const e = new Error('gone'); e.notFound = true; throw e; } });
  assert.equal(sess.ok, false);
  assert.equal(sess.state, 'NOT_CONNECTED');
  assert.equal(sess.reason, 'no_secret');
});

test('markInvalid audits a reason code only - never cookie values - and tags the secret INVALID', async () => {
  const { db, calls } = fakeDb();
  let labeled = null;
  const out = await markInvalid({ db, person: 'ashton-couture', platform: 'linkedin_personal',
    secretArn: 'arn', reasonCode: 'logged_out', setLabel: async (arn, v) => { labeled = { arn, v }; } });
  assert.equal(out.state, 'INVALID');
  const ev = calls.events.find((e) => e.event_type === 'session.invalid');
  assert.ok(ev);
  assert.equal(ev.payload.reason, 'logged_out');
  // The audit payload must not carry any cookie material.
  assert.equal(JSON.stringify(ev.payload).includes('SECRET-COOKIE'), false);
  assert.deepEqual(labeled, { arn: 'arn', v: 'INVALID' });
});
