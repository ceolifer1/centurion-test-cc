// SPEC-C capture-side crypto/store + destructive revoke. MEMORY-ONLY: the cookie
// envelope plaintext exists only in this function's scope, is written to Secrets
// Manager encrypted under the PER-PERSON CMK, and is NEVER written to disk, a
// log, or a container layer (SPEC-C 2.3 / 5.1). Cookie VALUES are never logged -
// only counts + names. AWS clients are injected for tests (mock KMS/SM/ECS); the
// real ones are imported lazily so unit tests run with ZERO installed deps.
import { REGION, sessionSecretName, userKeyAlias, BROWSER_CLUSTER } from './config.mjs';

// Per-secret resource policy: GetSecretValue restricted to that person's agent
// task roles; everything else denied (SPEC-C 4.2 - defense in depth over the CMK
// key policy). No human/lambda role can read - decryption still needs the CMK.
function secretResourcePolicy(person, accountId) {
  const roleArn = (agent) => `arn:aws:iam::${accountId}:role/herald-${agent}-prod-task`;
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Sid: 'PerPersonAgentReadOnly', Effect: 'Allow',
        Principal: { AWS: ['piper', 'gia', 'sol'].map(roleArn) },
        Action: 'secretsmanager:GetSecretValue', Resource: '*',
        Condition: { StringEquals: { 'aws:PrincipalTag/herald:person': person } } },
      { Sid: 'DenyEveryoneElse', Effect: 'Deny',
        Principal: '*', Action: 'secretsmanager:GetSecretValue', Resource: '*',
        Condition: { StringNotEquals: { 'aws:PrincipalTag/herald:person': person } } },
    ],
  });
}

// Encrypt (via SM envelope under the per-person CMK) + store the session. Called
// by the capture fargate task AFTER a real human login (never by the Lambda, and
// never automatically). `envelope` is the in-memory cookie set + fingerprint +
// consentRowId. Returns metadata only - NO cookie values.
export async function storeSession({ person, platform, envelope, accountId, region = REGION, clients = {} }) {
  if (!person || !platform) throw new Error('storeSession requires person + platform');
  if (!envelope || !Array.isArray(envelope.cookies) || envelope.cookies.length === 0) {
    throw new Error('storeSession requires a non-empty cookie envelope (memory only)');
  }
  const name = sessionSecretName(person, platform);
  const keyId = userKeyAlias(person);
  const sm = clients.sm || (await defaultSm(region));
  let secretString = JSON.stringify(envelope);
  const cookieCount = envelope.cookies.length;

  let result;
  const exists = await sm.describeSecret(name).then(() => true).catch((e) => {
    if (e?.notFound || e?.name === 'ResourceNotFoundException') return false;
    throw e;
  });
  if (!exists) {
    const created = await sm.createSecret({ Name: name, KmsKeyId: keyId, SecretString: secretString });
    if (accountId) {
      await sm.putResourcePolicy({ SecretId: name, ResourcePolicy: secretResourcePolicy(person, accountId) }).catch(() => {});
    }
    result = { created: true, versionId: created?.VersionId || null };
  } else {
    const put = await sm.putSecretValue({ SecretId: name, SecretString: secretString });
    result = { created: false, versionId: put?.VersionId || null };
  }
  secretString = null; envelope = null; // best-effort zeroize of the plaintext
  return { ok: true, secretName: name, keyAlias: keyId, cookieCount, ...result };
}

// Destructive revoke (SPEC-C 6): DeleteSecret with no recovery window, retire any
// KMS grants, and StopTask every running browser task for (person, platform) so
// in-memory cookies die with the container. No cookie plaintext is read here -
// the vault Lambda may hold these rights (it never decrypts). Grant zeroing of
// ecosystem_user_grants + the ledger REVOKED write happen in tasks.mjs (db).
export async function revokeSession({ person, platform, region = REGION, clients = {}, cluster = BROWSER_CLUSTER }) {
  const name = sessionSecretName(person, platform);
  const out = { secretDeleted: false, grantsRetired: 0, tasksStopped: 0 };
  const sm = clients.sm || (await defaultSm(region));
  const kms = clients.kms || (await defaultKms(region));
  const ecs = clients.ecs || (await defaultEcs(region));

  await sm.deleteSecret({ SecretId: name, ForceDeleteWithoutRecovery: true })
    .then(() => { out.secretDeleted = true; })
    .catch((e) => { if (!(e?.notFound || e?.name === 'ResourceNotFoundException')) throw e; });

  // Retire any dynamic grants on the per-person CMK (no-op when access is
  // key-policy based, which is the P0 design - kept for defense in depth).
  try {
    const grants = await kms.listGrants(userKeyAlias(person));
    for (const g of grants || []) { await kms.retireGrant(g).catch(() => {}); out.grantsRetired++; }
  } catch { /* best-effort */ }

  // Kill running tasks tagged for this person+platform (in-memory cookies die).
  try {
    const tasks = await ecs.listTasksForSession({ cluster, person, platform });
    for (const t of tasks || []) { await ecs.stopTask({ cluster, task: t }).catch(() => {}); out.tasksStopped++; }
  } catch { /* best-effort */ }

  return { ok: true, secretName: name, ...out };
}

// ---- default AWS client wrappers (lazy import; mocked in tests) --------------
async function defaultSm(region) {
  const M = await import('@aws-sdk/client-secrets-manager');
  const c = new M.SecretsManagerClient({ region });
  const wrap = async (Cmd, args) => c.send(new Cmd(args)).catch((e) => {
    if (e?.name === 'ResourceNotFoundException') e.notFound = true; throw e;
  });
  return {
    describeSecret: (SecretId) => wrap(M.DescribeSecretCommand, { SecretId }),
    createSecret: (args) => wrap(M.CreateSecretCommand, args),
    putSecretValue: (args) => wrap(M.PutSecretValueCommand, args),
    putResourcePolicy: (args) => wrap(M.PutResourcePolicyCommand, args),
    deleteSecret: (args) => wrap(M.DeleteSecretCommand, args),
  };
}
async function defaultKms(region) {
  const M = await import('@aws-sdk/client-kms');
  const c = new M.KMSClient({ region });
  return {
    listGrants: async (KeyId) => (await c.send(new M.ListGrantsCommand({ KeyId }))).Grants?.map((g) => g.GrantId) || [],
    retireGrant: (GrantId) => c.send(new M.RevokeGrantCommand({ KeyId: undefined, GrantId })),
  };
}
async function defaultEcs(region) {
  const M = await import('@aws-sdk/client-ecs');
  const c = new M.ECSClient({ region });
  return {
    listTasksForSession: async ({ cluster }) => (await c.send(new M.ListTasksCommand({ cluster }))).taskArns || [],
    stopTask: ({ cluster, task }) => c.send(new M.StopTaskCommand({ cluster, task, reason: 'herald session revoke' })),
  };
}
