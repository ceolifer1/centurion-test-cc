// Test fixtures for herald-cass. Env-injected secrets (op-agent pattern) so
// config.secrets() never imports @aws-sdk during unit tests.
process.env.CF_SERVICE_KEY = process.env.CF_SERVICE_KEY || 'test-service-key';
process.env.CF_ANON_KEY = process.env.CF_ANON_KEY || 'test-anon-key';
process.env.ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || 'test-anthropic-key';

export const ASHTON_FF = {
  person_id: 'ashton-couture', name: 'Ashton Couture', role_title: 'Founder & CEO',
  platforms: ['linkedin_personal', 'x'],
  approved_claims: [
    { claim_id: 'AC-01', text: '28 years across software, banking technology, and commercial finance' },
    { claim_id: 'AC-03', text: 'Centurion Financial founded 2021' },
  ],
};

export function fakeDb(overrides = {}) {
  const calls = { events: [], usage: [], runs: [], runPatches: [], scheduleInserts: [] };
  let seq = 0;
  const db = {
    readControls: async () => [{ scope: 'global', state: 'run' }],
    insertEvent: async (row) => { calls.events.push(row); },
    insertUsage: async (row) => { calls.usage.push(row); },
    insertRun: async (row) => { calls.runs.push(row); },
    patchRun: async (id, row) => { calls.runPatches.push({ id, ...row }); },
    insertSchedule: async (row) => { const id = `sch-${++seq}`; calls.scheduleInserts.push({ id, ...row }); return { id }; },
    getFactFile: async () => ({ person_id: 'ashton-couture', data: ASHTON_FF, version: 1 }),
    monthSpendCents: async () => 0,
    ...overrides,
  };
  return { db, calls };
}

// Fake ideation model: returns a JSON theme array.
export const fakeIdeation = (themes = ['capital formation', 'market structure', 'firm perspective']) =>
  async () => ({ text: JSON.stringify(themes), model: 'claude-sonnet-5', usage: { input_tokens: 300, output_tokens: 60 }, costCents: 2 });
