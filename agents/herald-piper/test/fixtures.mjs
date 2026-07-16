// Test fixtures for herald-piper. Env-injected service key (op-agent pattern) so
// config.secrets() never imports @aws-sdk. Everything AWS/Playwright/Supabase is
// mocked at the boundary - node --test runs with ZERO installed deps.
process.env.CF_SERVICE_KEY = process.env.CF_SERVICE_KEY || 'test-service-key';
delete process.env.HERALD_LIVE; // dry-run default ON for tests

// Valid session envelope as stored in Secrets Manager (SPEC-C 4.2).
export const SESSION_ENVELOPE = JSON.stringify({
  cookies: [
    { name: 'li_at', value: 'SECRET-COOKIE', domain: '.linkedin.com', path: '/' },
    { name: 'JSESSIONID', value: 'SECRET-JSESSION', domain: '.linkedin.com', path: '/' },
  ],
  userAgent: 'Mozilla/5.0 (captured fingerprint)',
  viewport: { width: 1280, height: 800 },
  capturedAt: '2026-07-01T00:00:00Z',
  consentRowId: 'consent-1',
  platform: 'linkedin_personal',
});

export function fakeDb(overrides = {}) {
  const calls = { events: [], runPatches: [], queuePatches: [], reserves: [], commits: [], rollbacks: [] };
  const db = {
    readControls: async () => [{ scope: 'global', state: 'run' }],
    insertEvent: async (row) => { calls.events.push(row); },
    insertRun: async (row) => { calls.runs = (calls.runs || []).concat(row); },
    patchRun: async (id, row) => { calls.runPatches.push({ id, ...row }); },
    getQueueItem: async () => null,
    patchQueueItem: async (id, row) => { calls.queuePatches.push({ id, ...row }); },
    reserveAction: async (...a) => { calls.reserves.push(a); return { allowed: true }; },
    commitAction: async (...a) => { calls.commits.push(a); },
    rollbackAction: async (...a) => { calls.rollbacks.push(a); },
    lastActionAt: async () => null,
    ...overrides,
  };
  return { db, calls };
}

// A Playwright browser/context double. Records the cookies injected and whether
// the browser was closed. newPage() returns a stub page for the default probe.
export function fakeBrowser() {
  const calls = { addCookies: null, closed: false, pages: 0 };
  const context = {
    addCookies: async (c) => { calls.addCookies = c; },
    newPage: async () => { calls.pages++; return { goto: async () => {}, evaluate: async () => true, close: async () => {} }; },
  };
  const browser = { close: async () => { calls.closed = true; } };
  return { launch: async () => ({ browser, context }), calls, context, browser };
}

export const APPROVED_ITEM = (extra = {}) => ({
  id: 'q-1', person: 'ashton-couture', platform: 'linkedin_personal', kind: 'post',
  status: 'approved', tier: 'run', body: 'A quiet, factual institutional update.', ...extra,
});

// Monday 2026-07-13 10:00 America/Chicago -> inside active hours for posts.
export const VALID_NOW = () => new Date('2026-07-13T15:00:00Z');
