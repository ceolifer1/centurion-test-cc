// Mirrors of the herald_fact_files DB seeds (migration herald_substrate_v1),
// which themselves mirror SPEC-E 3.1/3.2 + the locked 2026-07-10 roster.
export const ASHTON = {
  person_id: 'ashton-couture',
  name: 'Ashton Couture',
  role_title: 'Founder & CEO',
  location: 'Houston, TX',
  approved_bio: 'Ashton Couture is the Founder & CEO of Centurion Financial (founded 2021). With 28 years across software, banking technology, and commercial finance, he builds the infrastructure that makes capital access faster and cleaner. Earlier in his career he delivered systems to Microsoft, Credit Suisse, CH2M Hill (now Jacobs Engineering), and Chase.',
  bio_approved: true,
  verified_employers: [
    { org: 'Microsoft', relationship: 'client-delivery', verified: true },
    { org: 'Credit Suisse', relationship: 'client-delivery', verified: true },
    { org: 'CH2M Hill (now Jacobs Engineering)', relationship: 'client-delivery', verified: true },
    { org: 'Chase', relationship: 'client-delivery', verified: true },
    { org: 'Powered Labs', relationship: 'exit', note: 'One line only: 2010-2018, exited (F-005)', verified: true },
    { org: 'Centurion Financial', relationship: 'employer', note: 'founded 2021', verified: true },
  ],
  education: [{ school: 'TODO', degree: 'TODO', note: 'not verified - do not publish' }],
  do_not_say: [
    { term: 'AUM', reason: 'global VERA-T01' },
    { term: 'raised $X', pattern: '\\braised\\s+\\$?\\d', reason: 'global VERA-T02' },
    { term: '$2B', pattern: '\\$\\s*2\\s*(B\\b|Bn\\b|billion\\b)', reason: 'global VERA-T03' },
    { term: 'Sum Capital', reason: 'global VERA-T05' },
    { term: 'founded 1999', reason: 'global VERA-T04' },
  ],
  approved_claims: [
    { claim_id: 'AC-01', text: '28 years across software, banking technology, and commercial finance', evidence: 'kyc:fact-base + team page' },
    { claim_id: 'AC-02', text: 'Principal track record spanning debt placements and sponsor-side participation across more than a thousand transactions', evidence: 'team page' },
    { claim_id: 'AC-03', text: 'Centurion Financial founded 2021', evidence: 'registry F-001' },
    { claim_id: 'AC-04', text: 'Powered Labs (2010-2018, exited)', evidence: 'registry F-005' },
  ],
  approved_links: [{ kind: 'site', url: 'centurionfinancial.com', verified: true }],
  headshot: { status: 'approved', asset: 'assets/team/ashton-couture.jpg' },
  sign_off: { signed_off: true, signed_off_by: 'Ashton Couture', signed_off_at: '2026-07-07', state: 'publish_enabled_crawl' },
  version: 1,
};

export const JASMINE = {
  person_id: 'jasmine-amaso',
  name: 'Jasmine Amaso',
  role_title: 'President - Global Capital Markets',
  location: 'Dubai & Houston',
  approved_bio: '20+ years in institutional real assets and capital formation.',
  bio_approved: true,
  verified_employers: [
    { org: 'JLL', relationship: 'employer', verified: true },
    { org: 'BBVA Compass', relationship: 'employer', verified: true },
    { org: 'Centurion Financial', relationship: 'employer', verified: true },
  ],
  education: [
    { school: 'Columbia University', degree: 'M.S., Sustainability Management' },
    { school: 'Rice University', degree: 'B.A. + professional degree, Architecture' },
  ],
  do_not_say: [
    { term: 'raised $1.28B', pattern: '\\braised\\b.{0,30}1\\.28', reason: 'term sheets, not raised capital (F-004)' },
  ],
  approved_claims: [
    { claim_id: 'JA-01', text: '20+ years in institutional real assets and capital formation', evidence: 'team page' },
    { claim_id: 'JA-02', text: '$1.28B+ in lender and investor term sheets across UAE real estate', evidence: 'team page' },
    { claim_id: 'JA-03', text: 'GE Healthcare onboarding across 42 countries (at JLL)', evidence: 'team page' },
  ],
  approved_links: [],
  headshot: { status: 'approved', asset: 'assets/team/jasmine-amaso.jpg' },
  // Note SPEC-E 3.2: written consent record is TODO -> VERA-N03 must treat
  // this file as NOT signed off until signed_off_by/at are filled.
  sign_off: { signed_off: true, signed_off_by: "TODO - written record of Jasmine's one-line OK", signed_off_at: null, state: 'publish_enabled_crawl' },
  version: 1,
};

export const STEPHEN = {
  person_id: 'stephen-warren', name: 'Stephen Warren',
  role_title: 'TODO - pending fact-file intake', location: '', approved_bio: '', bio_approved: false,
  verified_employers: [], education: [], do_not_say: [], approved_claims: [], approved_links: [],
  headshot: { status: 'missing' },
  sign_off: { signed_off: false, state: 'bio_submitted' }, version: 1,
};

export const ANWAR = {
  person_id: 'anwar-ferguson', name: 'Anwar Ferguson',
  role_title: 'TODO - pending fact-file intake', location: '', approved_bio: '', bio_approved: false,
  verified_employers: [], education: [], do_not_say: [], approved_claims: [], approved_links: [],
  headshot: { status: 'missing' },
  sign_off: { signed_off: false, state: 'draft_only' }, version: 1,
};

export const SIGNED_ANWAR = {
  ...ANWAR,
  sign_off: { signed_off: true, signed_off_by: 'Ashton Couture', signed_off_at: '2026-07-11', state: 'signed_off' },
};

// A clean baseline item for Ashton that must pass every rule.
export const CLEAN_ITEM = {
  person: 'ashton-couture', platform: 'linkedin_personal', kind: 'post',
  body: 'Ashton Couture, Founder & CEO of Centurion Financial (founded 2021). 28 years across software, banking technology, and commercial finance. We build the infrastructure that makes capital access faster and cleaner.',
};

export const item = (body, extra = {}) => ({ ...CLEAN_ITEM, body, ...extra });
