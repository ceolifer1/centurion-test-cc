// Test fixtures for herald-gia. Env-injected service key (op-agent pattern) so
// config.secrets() never imports @aws-sdk. Everything AWS/Anthropic/Supabase is
// mocked at the boundary - node --test runs with ZERO installed deps.
process.env.CF_SERVICE_KEY = process.env.CF_SERVICE_KEY || 'test-service-key';

// Ashton is signed off (VERA-N03 passes). Mirrors the herald_fact_files seed.
export const ASHTON = {
  person_id: 'ashton-couture',
  name: 'Ashton Couture',
  role_title: 'Founder & CEO',
  approved_bio: 'Founder & CEO of Centurion Financial (founded 2021).',
  bio_approved: true,
  topic_graph: ['private credit', 'commercial finance', 'capital markets'],
  approved_claims: [
    { claim_id: 'AC-03', text: 'Centurion Financial founded 2021' },
  ],
  do_not_say: [{ term: 'AUM' }],
  sign_off: { signed_off: true, signed_off_by: 'Ashton Couture', signed_off_at: '2026-07-20', state: 'publish_enabled_crawl' },
  version: 1,
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

// A Vera double. pass() => review_content passes; bounce(ids) => it bounces.
export const veraPass = async () => ({ verdict: 'pass', vera: { verdict: 'pass', rule_ids: [], bounce_reasons: [], gates: [] } });
export const veraBounce = (ids = ['VERA-T01']) => async () => ({
  verdict: 'bounce', vera: { verdict: 'bounce', rule_ids: ids, bounce_reasons: ids.map((i) => `${i}: "x"`), gates: [] },
});

// Warm + cold engagement targets (SPEC-D warm-only).
export const WARM_CONNECTION = { ref: 'https://linkedin.com/in/known', kind: 'profile', relationship: 'connection' };
export const WARM_CRM = { ref: 'https://linkedin.com/in/funder', kind: 'profile', crm_tag: 'funder' };
export const WARM_TOPIC = { ref: 'https://linkedin.com/feed/post-1', kind: 'post', topics: ['private credit'] };
export const COLD_TARGET = { ref: 'https://linkedin.com/in/stranger', kind: 'profile' };

// Monday 2026-07-13 10:00 America/Chicago -> inside active hours.
export const VALID_NOW = () => '2026-07-13T15:00:00Z';
