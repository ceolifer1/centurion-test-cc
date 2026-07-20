// Test fixtures for herald-vault. Env-injected service key (op-agent pattern) so
// config.secrets() never imports @aws-sdk. KMS/SecretsManager/ECS are mocked at
// the boundary - node --test runs with ZERO installed deps and NO real AWS calls.
process.env.CF_SERVICE_KEY = process.env.CF_SERVICE_KEY || 'test-service-key';

// A cookie envelope as the capture task would build it (memory only). The value
// strings are sentinels so tests can assert they NEVER leak into returns/logs.
export const ENVELOPE = () => ({
  cookies: [
    { name: 'li_at', value: 'SENTINEL-COOKIE-A', domain: '.linkedin.com', path: '/' },
    { name: 'JSESSIONID', value: 'SENTINEL-COOKIE-B', domain: '.linkedin.com', path: '/' },
  ],
  userAgent: 'Mozilla/5.0 (captured fingerprint)',
  viewport: { width: 1280, height: 800 },
  capturedAt: '2026-07-20T00:00:00Z',
  consentRowId: 'consent-1',
  platform: 'linkedin_personal',
});

// Mock SecretsManager client. `exists` toggles the create vs put path.
export function mockSm({ exists = false } = {}) {
  const calls = { describe: [], create: [], put: [], policy: [], delete: [] };
  const sm = {
    describeSecret: async (id) => { calls.describe.push(id); if (!exists) { const e = new Error('nf'); e.notFound = true; throw e; } return { Name: id }; },
    createSecret: async (a) => { calls.create.push(a); return { VersionId: 'v-create' }; },
    putSecretValue: async (a) => { calls.put.push(a); return { VersionId: 'v-put' }; },
    putResourcePolicy: async (a) => { calls.policy.push(a); return {}; },
    deleteSecret: async (a) => { calls.delete.push(a); return {}; },
  };
  return { sm, calls };
}

export function mockKms({ grants = [] } = {}) {
  const calls = { list: [], retire: [] };
  return { kms: {
    listGrants: async (alias) => { calls.list.push(alias); return grants; },
    retireGrant: async (g) => { calls.retire.push(g); },
  }, calls };
}

export function mockEcs({ tasks = [] } = {}) {
  const calls = { list: [], stop: [] };
  return { ecs: {
    listTasksForSession: async (a) => { calls.list.push(a); return tasks; },
    stopTask: async (a) => { calls.stop.push(a); },
  }, calls };
}

export function fakeDb(overrides = {}) {
  const calls = { events: [], consent: [], consentPatches: [], runs: [], runPatches: [], grants: [], usage: [] };
  let seq = 0;
  const db = {
    readControls: async () => [{ scope: 'global', state: 'run' }],
    insertEvent: async (row) => { calls.events.push(row); },
    insertUsage: async (row) => { calls.usage.push(row); },
    insertRun: async (row) => { calls.runs.push(row); },
    patchRun: async (id, row) => { calls.runPatches.push({ id, ...row }); },
    insertConsent: async (row) => { const r = { id: `c-${++seq}`, ...row }; calls.consent.push(r); return r; },
    patchConsent: async (id, row) => { calls.consentPatches.push({ id, ...row }); },
    latestConsent: async () => calls.consent[calls.consent.length - 1] || null,
    zeroGrant: async (userId, caps) => { calls.grants.push({ userId, caps }); return { zeroed: !!userId, removed: caps.length }; },
    ...overrides,
  };
  return { db, calls };
}
