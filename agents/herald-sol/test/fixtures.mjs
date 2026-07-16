// Test fixtures for herald-sol. Env-injected secrets (op-agent pattern) so
// config.secrets() never imports @aws-sdk during unit tests. The four fact-files
// mirror the live herald_fact_files shape (approved_links[].kind drives presence).
process.env.CF_SERVICE_KEY = process.env.CF_SERVICE_KEY || 'test-service-key';
process.env.CF_ANON_KEY = process.env.CF_ANON_KEY || 'test-anon-key';

export const ASHTON_FF = {
  person_id: 'ashton-couture', name: 'Ashton Couture', role_title: 'Founder & CEO', location: 'Houston, TX',
  sign_off: { state: 'publish_enabled_crawl', signed_off: true },
  approved_bio: 'Ashton Couture is the Founder & CEO of Centurion Financial (founded 2021).',
  education: [],
  approved_links: [
    { url: 'linkedin.com/in/ashtoncouture', kind: 'linkedin', verified: true },
    { url: 'crunchbase.com/person/ashton-couture', kind: 'crunchbase', verified: true },
    { url: 'centurionfinancial.com', kind: 'site', verified: true },
  ],
  approved_claims: [{ claim_id: 'AC-03', text: 'Centurion Financial founded 2021' }],
};

export const JASMINE_FF = {
  person_id: 'jasmine-amaso', name: 'Jasmine Amaso', role_title: 'President - Global Capital Markets', location: 'Dubai & Houston',
  sign_off: { state: 'publish_enabled_crawl', signed_off: true },
  approved_bio: '20+ years in institutional real assets and capital formation.',
  education: [{ school: 'Columbia University', degree: 'M.S., Sustainability Management' }],
  approved_links: [
    { url: 'centurionfinancial.com/team/jasmine-amaso.html', kind: 'site', verified: true },
    { url: 'TODO - confirm her LinkedIn URL at connect-flow', kind: 'linkedin', verified: false },
    { url: 'TODO - not yet created', kind: 'crunchbase', verified: false },
  ],
  approved_claims: [],
};

export const STEPHEN_FF = {
  person_id: 'stephen-warren', name: 'Stephen Warren', role_title: 'TODO - pending fact-file intake', location: '',
  sign_off: { state: 'bio_submitted', signed_off: false }, education: [], approved_links: [], approved_claims: [],
};

export const ANWAR_FF = {
  person_id: 'anwar-ferguson', name: 'Anwar Ferguson', role_title: 'TODO - pending fact-file intake', location: '',
  sign_off: { state: 'draft_only', signed_off: false }, education: [], approved_links: [], approved_claims: [],
};

export const ROSTER_FILES = [
  { person_id: 'anwar-ferguson', data: ANWAR_FF },
  { person_id: 'ashton-couture', data: ASHTON_FF },
  { person_id: 'jasmine-amaso', data: JASMINE_FF },
  { person_id: 'stephen-warren', data: STEPHEN_FF },
];

export function fakeDb(overrides = {}) {
  const calls = { events: [], runs: [], runPatches: [], coverage: [] };
  const db = {
    readControls: async () => [{ scope: 'global', state: 'run' }],
    insertEvent: async (row) => { calls.events.push(row); },
    insertUsage: async (row) => { calls.usage = calls.usage || []; calls.usage.push(row); },
    insertRun: async (row) => { calls.runs.push(row); },
    patchRun: async (id, row) => { calls.runPatches.push({ id, ...row }); },
    getFactFile: async (pid) => ROSTER_FILES.find((f) => f.person_id === pid) || null,
    listFactFiles: async () => ROSTER_FILES,
    upsertCoverage: async (row) => { calls.coverage.push(row); },
    priorCoverageDate: async () => null,
    ...overrides,
  };
  return { db, calls };
}
