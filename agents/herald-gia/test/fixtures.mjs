// Test fixtures for herald-gia. Env-injected service key (op-agent pattern) so
// config.secrets() never imports @aws-sdk. Everything AWS/LinkedIn/Anthropic/
// Supabase is mocked at the boundary - node --test runs with ZERO installed deps
// and NEVER hits the real LinkedIn API.
process.env.CF_SERVICE_KEY = process.env.CF_SERVICE_KEY || 'test-service-key';
delete process.env.HERALD_LIVE; // dry-run default ON for tests unless a test opts in

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 60 * 24 * 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

// The vaulted OAuth token envelope herald-linkedin writes. FEED variant carries
// the Community-Management scope (w_member_social_feed) that live engagement
// needs; NOFEED carries only w_member_social (posts scope) => approval-gated.
export const TOKEN_FEED = JSON.stringify({
  access_token: 'SECRET-ACCESS-TOKEN', refresh_token: 'SECRET-REFRESH-TOKEN',
  expires_at: FAR_FUTURE, scope: 'w_member_social w_member_social_feed openid profile',
  author_urn: 'urn:li:person:ABC123',
});
export const TOKEN_NOFEED = JSON.stringify({
  access_token: 'SECRET-ACCESS-TOKEN', refresh_token: 'SECRET-REFRESH-TOKEN',
  expires_at: FAR_FUTURE, scope: 'w_member_social openid profile',
  author_urn: 'urn:li:person:ABC123',
});
export const TOKEN_EXPIRED = JSON.stringify({
  access_token: 'OLD', refresh_token: 'R', expires_at: PAST,
  scope: 'w_member_social w_member_social_feed', author_urn: 'urn:li:person:ABC123',
});

// Ashton is signed off (VERA-N03 passes). Mirrors the herald_fact_files seed.
export const ASHTON = {
  person_id: 'ashton-couture', name: 'Ashton Couture', role_title: 'Founder & CEO',
  approved_bio: 'Founder & CEO of Centurion Financial (founded 2021).', bio_approved: true,
  topic_graph: ['private credit', 'commercial finance', 'capital markets'],
  approved_claims: [{ claim_id: 'AC-03', text: 'Centurion Financial founded 2021' }],
  do_not_say: [{ term: 'AUM' }], version: 1,
};

export function fakeDb(overrides = {}) {
  const calls = { events: [], usage: [], runs: [], runPatches: [], queue: [], queuePatches: [],
    engagements: [], engagementPatches: [], reserves: [], commits: [], rollbacks: [] };
  let engSeq = 0; let qSeq = 0;
  const db = {
    readControls: async () => [{ scope: 'global', state: 'run' }],
    insertEvent: async (row) => { calls.events.push(row); },
    insertUsage: async (row) => { calls.usage.push(row); },
    insertRun: async (row) => { calls.runs.push(row); },
    patchRun: async (id, row) => { calls.runPatches.push({ id, ...row }); },
    insertQueueItem: async (row) => { const r = { id: `q-${++qSeq}`, ...row }; calls.queue.push(r); return r; },
    patchQueueItem: async (id, row) => { calls.queuePatches.push({ id, ...row }); },
    insertEngagement: async (row) => { const r = { id: `e-${++engSeq}`, ...row }; calls.engagements.push(r); return r; },
    patchEngagement: async (id, row) => { calls.engagementPatches.push({ id, ...row }); },
    getFactFile: async (person) => (person === 'ashton-couture' ? { data: ASHTON } : null),
    reserveAction: async (...a) => { calls.reserves.push(a); return { allowed: true }; },
    commitAction: async (...a) => { calls.commits.push(a); },
    rollbackAction: async (...a) => { calls.rollbacks.push(a); },
    lastActionAt: async () => null,
    monthSpendCents: async () => 0,
    ...overrides,
  };
  return { db, calls };
}

// A LinkedIn REST engagement fetch double: /rest/reactions -> 201 + x-restli-id,
// /rest/socialActions/{urn}/comments -> 201 + x-restli-id, userinfo -> sub.
// Records what was called (no token asserts leak).
export function fakeLinkedInFetch(over = {}) {
  const calls = { reactions: [], comments: [], userinfo: 0 };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rest/reactions')) {
      calls.reactions.push({ url: u, headers: opts.headers, body: JSON.parse(opts.body || '{}') });
      return { status: 201, ok: true, headers: new Map([['x-restli-id', 'urn:li:reaction:(urn:li:person:ABC123,urn:li:activity:7000000000000000001)']]), text: async () => '', json: async () => ({}) };
    }
    if (u.includes('/rest/socialActions/') && u.includes('/comments')) {
      calls.comments.push({ url: u, headers: opts.headers, body: JSON.parse(opts.body || '{}') });
      return { status: 201, ok: true, headers: new Map([['x-restli-id', 'urn:li:comment:(urn:li:activity:7000000000000000001,7102986562019213313)']]), text: async () => '', json: async () => ({}) };
    }
    if (u.includes('/v2/userinfo')) {
      calls.userinfo++;
      return { ok: true, status: 200, json: async () => ({ sub: 'ABC123', name: 'Ashton Couture' }) };
    }
    return { ok: false, status: 404, text: async () => 'not mocked' };
  };
  return { fetchImpl, calls, ...over };
}

// A Vera double. pass() => review_content passes; bounce(ids) => it bounces.
export const veraPass = async () => ({ verdict: 'pass', vera: { verdict: 'pass', rule_ids: [], bounce_reasons: [], gates: [] } });
export const veraBounce = (ids = ['VERA-T01']) => async () => ({
  verdict: 'bounce', vera: { verdict: 'bounce', rule_ids: ids, bounce_reasons: ids.map((i) => `${i}: "x"`), gates: [] },
});

// Curated / warm / cold engagement targets (each carries a POST URN, not a feed).
export const CURATED = { urn: 'urn:li:activity:7100000000000000001', action: 'like', curated: true };
export const WARM_CONNECTION = { urn: 'urn:li:activity:7100000000000000002', action: 'like', relationship: 'connection' };
export const WARM_TOPIC = { urn: 'urn:li:activity:7100000000000000003', action: 'like', topics: ['private credit'] };
export const COLD_TARGET = { urn: 'urn:li:activity:7100000000000000009', action: 'like' };

// Monday 2026-07-13 10:00 America/Chicago -> inside active hours.
export const VALID_NOW = () => '2026-07-13T15:00:00Z';
