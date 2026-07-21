// Test fixtures for herald-linkedin. Env-injected service key (op-agent pattern)
// so config.secrets() never imports @aws-sdk. Everything AWS/LinkedIn/Supabase is
// mocked at the boundary - node --test runs with ZERO installed deps and NEVER
// hits the real LinkedIn API.
process.env.CF_SERVICE_KEY = process.env.CF_SERVICE_KEY || 'test-service-key';
process.env.LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID || 'test-client-id';
process.env.LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET || 'test-client-secret';
delete process.env.HERALD_LIVE; // dry-run default ON for tests unless a test opts in

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 60 * 24 * 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

export const TOKEN_ENVELOPE = JSON.stringify({
  access_token: 'SECRET-ACCESS-TOKEN',
  refresh_token: 'SECRET-REFRESH-TOKEN',
  expires_at: FAR_FUTURE,
  scope: 'w_member_social openid profile',
  author_urn: 'urn:li:person:ABC123',
});

export const EXPIRED_TOKEN_ENVELOPE = JSON.stringify({
  access_token: 'OLD-ACCESS-TOKEN',
  refresh_token: 'SECRET-REFRESH-TOKEN',
  expires_at: PAST,
  scope: 'w_member_social openid profile',
  author_urn: 'urn:li:person:ABC123',
});

export function fakeDb(overrides = {}) {
  const calls = { events: [], runPatches: [], queuePatches: [], reserves: [], commits: [], rollbacks: [] };
  const db = {
    readControls: async () => [{ scope: 'global', state: 'run' }],
    insertEvent: async (row) => { calls.events.push(row); },
    insertRun: async (row) => { calls.runs = (calls.runs || []).concat(row); },
    patchRun: async (id, row) => { calls.runPatches.push({ id, ...row }); },
    getQueueItem: async () => VERA_PASS_ITEM(),
    patchQueueItem: async (id, row) => { calls.queuePatches.push({ id, ...row }); },
    listDue: async () => [],
    reserveAction: async (...a) => { calls.reserves.push(a); return { allowed: true }; },
    commitAction: async (...a) => { calls.commits.push(a); },
    rollbackAction: async (...a) => { calls.rollbacks.push(a); },
    lastActionAt: async () => null,
    ...overrides,
  };
  return { db, calls };
}

// A LinkedIn REST fetch double: /rest/posts -> 201 + x-restli-id; userinfo -> sub;
// oauth accessToken -> fresh token. Records what was called (no token asserts leak).
export function fakeLinkedInFetch(over = {}) {
  const calls = { posts: [], oauth: [], userinfo: 0 };
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('/rest/posts')) {
      calls.posts.push({ url, headers: opts.headers, body: JSON.parse(opts.body || '{}') });
      return { status: 201, ok: true, headers: new Map([['x-restli-id', 'urn:li:share:7000000000000000001']]), text: async () => '', json: async () => ({}) };
    }
    if (String(url).includes('/oauth/v2/accessToken')) {
      calls.oauth.push({ url, body: opts.body });
      return { ok: true, status: 200, json: async () => ({ access_token: 'NEW-ACCESS-TOKEN', refresh_token: 'NEW-REFRESH-TOKEN', expires_in: 5184000, refresh_token_expires_in: 31536000, scope: 'w_member_social' }) };
    }
    if (String(url).includes('/v2/userinfo')) {
      calls.userinfo++;
      return { ok: true, status: 200, json: async () => ({ sub: 'ABC123', name: 'Ashton Couture' }) };
    }
    return { ok: false, status: 404, text: async () => 'not mocked' };
  };
  return { fetchImpl, calls, ...over };
}

export const VERA_PASS = async () => ({ verdict: 'pass', vera: { verdict: 'pass', rule_ids: [], bounce_reasons: [] } });
export const VERA_BOUNCE = async () => ({ verdict: 'bounce', vera: { verdict: 'bounce', rule_ids: ['VERA-T02'], bounce_reasons: ['VERA-T02: "raised $5M"'] } });

export const VERA_PASS_ITEM = (extra = {}) => ({
  id: 'q-1', person: 'ashton-couture', platform: 'linkedin_personal', kind: 'post',
  status: 'vera_pass', tier: 'run', body: 'A quiet, factual institutional update from Centurion Financial.', ...extra,
});

// Monday 2026-07-13 10:00 America/Chicago -> inside active hours for posts.
export const VALID_NOW = () => new Date('2026-07-13T15:00:00Z');
