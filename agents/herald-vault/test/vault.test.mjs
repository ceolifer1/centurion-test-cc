// SPEC-C consent + revoke orchestration. Consent-BEFORE-secret ordering; revoke
// runs even under kill (a security control); mark_active flips the ledger without
// touching cookie values; non-security tasks fail-closed under kill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.mjs';
import { nextConsentState } from '../src/consent.mjs';
import { fakeDb, mockSm, mockKms, mockEcs } from './fixtures.mjs';

const userAuth = { authorize: async () => ({ type: 'user', userId: 'u-1', email: 'ashton@centurionfinancial.com' }) };
const ev = (task, payload) => ({ runId: `r-${task}`, mode: 'task', task, payload, __userToken: 'jwt', trace: { chain: [] } });

test('initiate_consent writes the PENDING ledger row BEFORE any secret exists (SPEC-C 3.2/7)', async () => {
  const { db, calls } = fakeDb();
  const handler = createHandler({ makeDb: async () => db, ...userAuth });
  const res = await handler(ev('initiate_consent', { person: 'ashton-couture', platform: 'linkedin_personal', grantedBy: 'ashton-couture' }));
  assert.equal(res.status, 'ok');
  assert.equal(calls.consent.length, 1);
  assert.equal(calls.consent[0].status, 'PENDING_CONSENT');
  assert.ok(calls.consent[0].scope.includes('herald.linkedin.session'));
  assert.ok(calls.events.some((e) => e.event_type === 'consent.initiated'));
  // No secret is created by the Lambda - capture is the fargate task's job.
});

test('initiate_consent rejects a non-vaulted platform', async () => {
  const { db } = fakeDb();
  const handler = createHandler({ makeDb: async () => db, ...userAuth });
  const res = await handler(ev('initiate_consent', { person: 'ashton-couture', platform: 'crunchbase' }));
  assert.equal(res.status, 'error');
});

test('mark_active flips the ledger to ACTIVE and audits counts only (no cookie values)', async () => {
  const { db, calls } = fakeDb();
  await db.insertConsent({ person: 'ashton-couture', platform: 'x', status: 'PENDING_CONSENT', scope: [] });
  const handler = createHandler({ makeDb: async () => db, ...userAuth });
  const res = await handler(ev('mark_active', { person: 'ashton-couture', platform: 'x', consentId: 'c-1', cookieCount: 2 }));
  assert.equal(res.status, 'ok');
  assert.ok(calls.consentPatches.some((p) => p.status === 'ACTIVE'));
  const captured = calls.events.find((e) => e.event_type === 'session.captured');
  assert.ok(captured);
  assert.equal(captured.payload.cookie_count, 2);
  assert.equal(JSON.stringify(captured).includes('SENTINEL'), false);
});

test('revoke_session RUNS under kill (security control) - deletes secret, stops tasks, zeroes grant, ledger REVOKED', async () => {
  const { db, calls } = fakeDb({ readControls: async () => [{ scope: 'global', state: 'kill' }] });
  await db.insertConsent({ person: 'ashton-couture', platform: 'linkedin_personal', status: 'ACTIVE', scope: [] });
  const { sm } = mockSm({ exists: true });
  const { kms } = mockKms();
  const { ecs } = mockEcs({ tasks: ['t1'] });
  const handler = createHandler({ makeDb: async () => db, ...userAuth, taskDeps: { clients: { sm, kms, ecs } } });
  const res = await handler(ev('revoke_session', { person: 'ashton-couture', platform: 'linkedin_personal', userId: 'u-1', revokedBy: 'ashton' }));
  assert.equal(res.status, 'ok', 'revoke is NOT blocked by the kill switch');
  assert.ok(calls.consentPatches.some((p) => p.status === 'REVOKED'));
  assert.ok(calls.grants.length === 1 && calls.grants[0].userId === 'u-1');
  assert.ok(calls.events.some((e) => e.event_type === 'session.revoked' && e.payload.secret_deleted === true));
});

test('a NON-security task (initiate_consent) is refused under kill (fail closed)', async () => {
  const { db, calls } = fakeDb({ readControls: async () => [{ scope: 'global', state: 'kill' }] });
  const handler = createHandler({ makeDb: async () => db, ...userAuth });
  const res = await handler(ev('initiate_consent', { person: 'ashton-couture', platform: 'x' }));
  assert.equal(res.status, 'killed');
  assert.equal(calls.consent.length, 0, 'no consent row written under kill');
});

test('session_status reports the ledger state', async () => {
  const { db } = fakeDb();
  await db.insertConsent({ person: 'ashton-couture', platform: 'x', status: 'ACTIVE', scope: [] });
  const handler = createHandler({ makeDb: async () => db, ...userAuth });
  const res = await handler(ev('session_status', { person: 'ashton-couture', platform: 'x' }));
  assert.equal(res.status, 'ok');
  assert.match(res.reply, /ACTIVE/);
});

test('consent state machine follows SPEC-C 7 transitions', () => {
  assert.equal(nextConsentState('PENDING_CONSENT', 'capture_success'), 'ACTIVE');
  assert.equal(nextConsentState('PENDING_CONSENT', 'consent_timeout'), 'ABANDONED');
  assert.equal(nextConsentState('ACTIVE', 'revoke'), 'REVOKED');
  assert.equal(nextConsentState('ACTIVE', 'expire'), 'EXPIRED');
  assert.throws(() => nextConsentState('REVOKED', 'reconsent'), /illegal consent transition/);
});
