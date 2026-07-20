// SPEC-C capture-side store + revoke: per-user KMS encryption (KmsKeyId =
// alias/herald/user/<person>), memory-only (cookie VALUES never leak into the
// return), and destructive revoke (DeleteSecret ForceDeleteWithoutRecovery +
// StopTask). Mock KMS/SecretsManager/ECS - no real AWS, no real session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeSession, revokeSession } from '../src/store.mjs';
import { userKeyAlias, sessionSecretName } from '../src/config.mjs';
import { ENVELOPE, mockSm, mockKms, mockEcs } from './fixtures.mjs';

test('storeSession encrypts under the PER-PERSON CMK and writes to the right secret path', async () => {
  const { sm, calls } = mockSm({ exists: false });
  const out = await storeSession({ person: 'ashton-couture', platform: 'linkedin_personal',
    envelope: ENVELOPE(), accountId: '262602454064', clients: { sm } });
  assert.equal(out.ok, true);
  assert.equal(out.secretName, sessionSecretName('ashton-couture', 'linkedin_personal'));
  assert.equal(out.keyAlias, userKeyAlias('ashton-couture'));
  assert.equal(out.cookieCount, 2);
  // The create used the per-person CMK - this is the whole point of per-person isolation.
  assert.equal(calls.create[0].KmsKeyId, 'alias/herald/user/ashton-couture');
  assert.equal(calls.create[0].Name, 'herald/sessions/ashton-couture/linkedin_personal');
  // A resource policy was attached scoping GetSecretValue to that person.
  assert.equal(calls.policy.length, 1);
  assert.match(calls.policy[0].ResourcePolicy, /herald:person/);
});

test('storeSession NEVER leaks cookie values in its return (memory-only, SPEC-C T3)', async () => {
  const { sm } = mockSm({ exists: false });
  const out = await storeSession({ person: 'ashton-couture', platform: 'linkedin_personal', envelope: ENVELOPE(), clients: { sm } });
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes('SENTINEL-COOKIE'), false, 'no cookie value in the return');
  assert.equal('cookies' in out, false);
});

test('storeSession on an EXISTING secret uses PutSecretValue (refresh), not CreateSecret', async () => {
  const { sm, calls } = mockSm({ exists: true });
  await storeSession({ person: 'ashton-couture', platform: 'x', envelope: { ...ENVELOPE(), platform: 'x' }, clients: { sm } });
  assert.equal(calls.create.length, 0);
  assert.equal(calls.put.length, 1);
  assert.equal(calls.put[0].SecretId, 'herald/sessions/ashton-couture/x');
});

test('storeSession refuses an empty cookie envelope (nothing to vault)', async () => {
  const { sm } = mockSm();
  await assert.rejects(() => storeSession({ person: 'p', platform: 'x', envelope: { cookies: [] }, clients: { sm } }), /non-empty cookie envelope/);
});

test('revokeSession is destructive: DeleteSecret with NO recovery window + StopTask running tasks', async () => {
  const { sm, calls: smc } = mockSm({ exists: true });
  const { kms } = mockKms({ grants: ['grant-1'] });
  const { ecs, calls: ecsc } = mockEcs({ tasks: ['task-arn-1', 'task-arn-2'] });
  const out = await revokeSession({ person: 'ashton-couture', platform: 'linkedin_personal', clients: { sm, kms, ecs } });
  assert.equal(out.ok, true);
  assert.equal(out.secretDeleted, true);
  assert.equal(smc.delete[0].ForceDeleteWithoutRecovery, true);
  assert.equal(out.tasksStopped, 2);
  assert.equal(ecsc.stop.length, 2);
});

test('revokeSession tolerates an already-deleted secret (idempotent teardown)', async () => {
  const sm = { deleteSecret: async () => { const e = new Error('gone'); e.notFound = true; throw e; } };
  const { kms } = mockKms();
  const { ecs } = mockEcs();
  const out = await revokeSession({ person: 'p', platform: 'x', clients: { sm, kms, ecs } });
  assert.equal(out.ok, true);
  assert.equal(out.secretDeleted, false);
});
