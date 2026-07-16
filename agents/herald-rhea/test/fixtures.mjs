// Test fixtures for herald-rhea. Env-injected secrets (op-agent pattern) so
// config.secrets() never imports @aws-sdk during unit tests.
process.env.CF_SERVICE_KEY = process.env.CF_SERVICE_KEY || 'test-service-key';
process.env.CF_ANON_KEY = process.env.CF_ANON_KEY || 'test-anon-key';
process.env.LEADCRM_KEY = process.env.LEADCRM_KEY || 'test-leadcrm-key';

export const QUEUE_ROWS = [
  { id: 'q1', person: 'ashton-couture', platform: 'linkedin_personal', kind: 'post', status: 'posted', title: 'Institutional focus', posted_at: '2026-07-08T14:00:00Z', external_ref: 'urn:li:1', tier: 'run' },
  { id: 'q2', person: 'jasmine-amaso', platform: 'x', kind: 'post', status: 'posted', title: 'Capital markets note', posted_at: '2026-07-09T15:00:00Z', external_ref: 'x:2', tier: 'run' },
  { id: 'q3', person: 'ashton-couture', platform: 'linkedin_personal', kind: 'post', status: 'bounced', title: 'Bad draft', tier: 'run' },
];

export const EVENTS = [
  { at: '2026-07-08T14:00:00Z', agent: 'piper', event_type: 'content.posted', person: 'ashton-couture', payload: { platform: 'linkedin_personal', impressions: 1200, reactions: 40, comments: 5 } },
  { at: '2026-07-09T15:00:00Z', agent: 'piper', event_type: 'content.posted', person: 'jasmine-amaso', payload: { platform: 'x', impressions: 800, reactions: 20, replies: 3 } },
  { at: '2026-07-09T16:00:00Z', agent: 'gia', event_type: 'followers.delta', payload: { delta: 12 } },
  { at: '2026-07-10T10:00:00Z', agent: 'vera', event_type: 'caps.warning', payload: { platform: 'linkedin_personal' } },
  { at: '2026-07-10T11:00:00Z', agent: 'gia', event_type: 'follow.suggested', person: 'ashton-couture', payload: { target: 'someone' } },
  { at: '2026-07-10T11:05:00Z', agent: 'gia', event_type: 'follow.suggested', person: 'ashton-couture', payload: { target: 'another' } },
];

export const COVERAGE = { date: '2026-07-10', rows: [
  { person: '_roster', score: 14.3, present: 4, total: 28, gaps: [] },
  { person: 'ashton-couture', score: 42.9, present: 3, total: 7, gaps: ['x', 'wikidata'] },
] };

// SPEC-F Option A sample deals (leadcrm shape via embedded select).
export const DEALS = [
  { lending_amount: 4148000000, amount: 5291500000, pipeline_stages: { is_won: false, is_lost: false, pipelines: { name: 'Enterprise' } } },
  { lending_amount: 40000000, amount: 45000000, pipeline_stages: { is_won: false, is_lost: false, pipelines: { name: 'Enterprise' } } },
  { lending_amount: 0, amount: 28500000, pipeline_stages: { is_won: false, is_lost: false, pipelines: { name: 'Funding' } } },
  { lending_amount: 999, amount: 999, pipeline_stages: { is_won: true, is_lost: false, pipelines: { name: 'Enterprise' } } },   // won -> excluded
  { lending_amount: 500, amount: 5000000, pipeline_stages: { is_won: false, is_lost: false, pipelines: { name: 'Commercial Real Estate' } } }, // other pipeline -> excluded
];

export function fakeDb(overrides = {}) {
  const calls = { events: [], runs: [], runPatches: [], reportUpserts: [], reportSent: [] };
  let seq = 0;
  const db = {
    readControls: async () => [{ scope: 'global', state: 'run' }],
    insertEvent: async (row) => { calls.events.push(row); },
    insertRun: async (row) => { calls.runs.push(row); },
    patchRun: async (id, row) => { calls.runPatches.push({ id, ...row }); },
    queueInWindow: async () => QUEUE_ROWS,
    needsYouOpen: async () => [{ id: 'q9', person: 'stephen-warren', platform: 'linkedin_personal', title: 'Held' }],
    eventsInWindow: async () => EVENTS,
    coverageOnOrBefore: async () => COVERAGE,
    priorReport: async () => ({ metrics: { engagement: { reach: 1000, total: 50 }, followers: { net_new: 8 }, coverage: { roster_score: 12.0 } } }),
    upsertReport: async (row) => { const id = `rep-${++seq}`; calls.reportUpserts.push({ id, ...row }); return { id }; },
    markReportSent: async (id, to, at) => { calls.reportSent.push({ id, to, at }); },
    ...overrides,
  };
  return { db, calls };
}

export const fakePipeline = (over = {}) => async () => ({
  value: 4750000000, deal_count: 37, currency: 'USD', display: '$4.7B+',
  basis: 'capital-sought (SPEC-F Option A)', framing: 'current active pipeline', ...over,
});
