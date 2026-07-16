// Test fixtures for herald-nico. Env-injected secrets (op-agent pattern) so
// config.secrets() never imports @aws-sdk during unit tests.
process.env.CF_SERVICE_KEY = process.env.CF_SERVICE_KEY || 'test-service-key';
process.env.CF_ANON_KEY = process.env.CF_ANON_KEY || 'test-anon-key';
process.env.ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || 'test-anthropic-key';

export const ASHTON_FF = {
  person_id: 'ashton-couture',
  name: 'Ashton Couture',
  role_title: 'Founder & CEO',
  approved_bio: 'Ashton Couture is the Founder & CEO of Centurion Financial (founded 2021).',
  approved_claims: [
    { claim_id: 'AC-01', text: '28 years across software, banking technology, and commercial finance' },
    { claim_id: 'AC-03', text: 'Centurion Financial founded 2021' },
  ],
  do_not_say: [{ term: 'AUM' }, { term: 'raised $X' }],
};

// A Vera "pass" response (as normalized by vera.mjs -> gateAndFinalize consumes
// { verdict, status, vera, blocked }).
export const veraPass = () => ({
  verdict: 'pass', status: 'ok', blocked: false,
  vera: {
    verdict: 'pass', at: '2026-07-11T00:00:00Z',
    gates: [
      { gate: 'fact_base', ok: true }, { gate: 'brand_voice', ok: true },
      { gate: 'legal_claims', ok: true }, { gate: 'platform_tos', ok: true },
    ],
    bounce_reasons: [], suggested_rewrite: null, model: 'deterministic', version: 1,
    rule_ids: [], hold_for_human: false,
  },
});

export const veraBounce = () => ({
  verdict: 'bounce', status: 'ok', blocked: false,
  vera: {
    verdict: 'bounce', at: '2026-07-11T00:00:00Z',
    gates: [{ gate: 'fact_base', ok: false }],
    bounce_reasons: ['VERA-T01: "our AUM is huge"'],
    suggested_rewrite: 'reframe as advisory volume', model: 'deterministic', version: 1,
    rule_ids: ['VERA-T01'], hold_for_human: false,
  },
});

// Fake CF-prod db. Records every write for assertions.
export function fakeDb(overrides = {}) {
  const calls = { events: [], usage: [], runs: [], runPatches: [], queueInserts: [], queuePatches: [] };
  let seq = 0;
  const db = {
    readControls: async () => [{ scope: 'global', state: 'run' }],
    insertEvent: async (row) => { calls.events.push(row); },
    insertUsage: async (row) => { calls.usage.push(row); },
    insertRun: async (row) => { calls.runs.push(row); },
    patchRun: async (id, row) => { calls.runPatches.push({ id, ...row }); },
    insertQueueItem: async (row) => { const id = `q-${++seq}`; calls.queueInserts.push({ id, ...row }); return { id }; },
    getQueueItem: async () => null,
    patchQueueItem: async (id, row) => { calls.queuePatches.push({ id, ...row }); },
    listBounced: async () => [],
    getFactFile: async () => ({ person_id: 'ashton-couture', data: ASHTON_FF, version: 1 }),
    monthSpendCents: async () => 0,
    ...overrides,
  };
  return { db, calls };
}

// Fake model + Vera injected via taskDeps.
export const fakeModel = (text = 'A quiet, factual institutional update from Centurion Financial.') =>
  async () => ({ text, model: 'claude-sonnet-5', usage: { input_tokens: 400, output_tokens: 120 }, costCents: 3 });

export const fakeVera = (resp) => async () => resp;
