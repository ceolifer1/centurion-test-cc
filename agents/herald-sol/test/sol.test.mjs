// herald-sol contract + generation tests. CF-prod db is mocked - node --test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, MANIFEST } from '../src/index.mjs';
import { buildEntityGraph } from '../src/jsonld.mjs';
import { computeScorecard } from '../src/coverage.mjs';
import { fakeDb, ASHTON_FF, ROSTER_FILES } from './fixtures.mjs';

const NOW = '2026-07-13T00:00:00Z';
const make = (db, taskDeps, extra = {}) => createHandler({
  makeDb: async () => db, now: () => NOW, taskDeps,
  authorize: async () => ({ type: 'user', userId: 'ceo', email: 'ceo@centurionfinancial.com', role: 'company_admin' }),
  ...extra,
});
const env = (task, payload, extra = {}) => ({
  runId: '11111111-1111-4111-8111-111111111111', mode: 'task', task,
  actor: { userId: 'ceo' }, __userToken: 'ceo-jwt', payload, trace: { chain: [] }, ...extra,
});

test('GET /manifest returns the AGT-2 shape (sol, four caps, deterministic)', async () => {
  const { db } = fakeDb();
  const res = await make(db, {})({ requestContext: { http: { method: 'GET' } }, rawPath: '/manifest' });
  assert.equal(res.statusCode, 200);
  const m = JSON.parse(res.body);
  assert.equal(m.service, 'herald-sol');
  assert.deepEqual(m.capabilities, ['entity_graph', 'coverage_audit', 'serp_audit', 'knowledge_panel']);
  assert.equal(m.deterministic_only, true);
  assert.equal(m.generate_not_submit, true);
  assert.equal(MANIFEST.engine, 'herald');
});

test('entity_graph emits valid Person + Organization JSON-LD with sameAs + Wikidata seeds', () => {
  const g = buildEntityGraph(ASHTON_FF);
  assert.equal(g.person_jsonld['@type'], 'Person');
  assert.equal(g.person_jsonld['@context'], 'https://schema.org');
  assert.equal(g.person_jsonld.jobTitle, 'Founder & CEO');
  assert.equal(g.person_jsonld.worksFor.name, 'Centurion Financial');
  // sameAs carries the verified real links, https-normalized, no TODO/unverified.
  assert.ok(g.sameAs.includes('https://linkedin.com/in/ashtoncouture'));
  assert.ok(g.sameAs.every((u) => /^https:\/\//.test(u) && !/todo/i.test(u)));
  assert.equal(g.organization_jsonld['@type'], 'Organization');
  assert.equal(g.organization_jsonld.foundingDate, '2021');
  // Wikidata seeds are referenced (every statement carries a reference).
  assert.ok(g.wikidata_seeds.length >= 2);
  assert.ok(g.wikidata_seeds.every((s) => s.reference));
  assert.ok(g.wikidata_seeds.some((s) => s.property === 'P31' && s.value === 'Q5'));
});

test('entity_graph task writes an event per person and returns graphs', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db, {})(env('entity_graph', { person: 'ashton-couture' }));
  assert.equal(res.status, 'ok');
  assert.equal(res.artifacts[0].type, 'entity_graph');
  assert.equal(res.artifacts[0].data.people.length, 1);
  assert.ok(calls.events.some((e) => e.event_type === 'entity.graph_built'));
});

test('coverage_audit computes per-person gaps for the 4-person roster + writes snapshots', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db, {})(env('coverage_audit', {}));
  assert.equal(res.status, 'ok');
  const { persons, roster } = res.artifacts[0].data;
  assert.equal(persons.length, 4);
  // Ashton: linkedin + crunchbase + entity_home present => 3/7, gaps include x + wikidata.
  const ash = persons.find((p) => p.person === 'ashton-couture');
  assert.equal(ash.present_count, 3);
  assert.ok(ash.gaps.includes('x'));
  assert.ok(ash.gaps.includes('wikidata'));
  // Jasmine: only the verified site link counts (LinkedIn/Crunchbase are TODO) => 1/7.
  const jas = persons.find((p) => p.person === 'jasmine-amaso');
  assert.equal(jas.present_count, 1);
  // Stephen + Anwar have no links => 0.
  assert.equal(persons.find((p) => p.person === 'stephen-warren').present_count, 0);
  assert.equal(roster.total, 28);
  assert.equal(roster.present, 4);
  // Persisted: 4 person rows + 1 roster rollup row, idempotent on the date.
  assert.equal(calls.coverage.length, 5);
  assert.ok(calls.coverage.some((r) => r.person === '_roster'));
  assert.ok(calls.coverage.every((r) => r.snapshot_date === '2026-07-13'));
  assert.ok(calls.events.some((e) => e.event_type === 'coverage.audited'));
});

test('coverage scorecard math is a pure function of the fact-files', () => {
  const { persons, roster } = computeScorecard(ROSTER_FILES);
  assert.equal(roster.present, 4);
  assert.equal(persons.reduce((a, p) => a + p.present_count, 0), 4);
});

test('serp_audit with injected results scores owned share + panel', async () => {
  const { db, calls } = fakeDb();
  const results = [
    { title: 'Centurion Financial', url: 'https://centurionfinancial.com', rank: 1 },
    { title: 'Ashton on LinkedIn', url: 'https://linkedin.com/in/ashtoncouture', rank: 2 },
    { title: 'Some news site', url: 'https://news.example.com/x', rank: 3 },
    { title: 'KP', url: 'https://google.com', rank: 0, type: 'knowledge_panel' },
  ];
  const res = await make(db, {})(env('serp_audit', { query: 'Centurion Financial', results, ownedDomains: ['centurionfinancial.com', 'linkedin.com'] }));
  assert.equal(res.status, 'ok');
  const d = res.artifacts[0].data;
  assert.equal(d.source, 'injected');
  assert.equal(d.owned_in_top10, 2);
  assert.equal(d.knowledge_panel_present, true);
  assert.ok(calls.events.some((e) => e.event_type === 'serp.audited'));
});

test('serp_audit with no source returns a well-formed stub (no paid-API dependency)', async () => {
  const { db } = fakeDb();
  const res = await make(db, {})(env('serp_audit', { query: 'Centurion Financial' }));
  assert.equal(res.status, 'ok');
  assert.equal(res.artifacts[0].data.status, 'stub');
  assert.equal(res.artifacts[0].data.source, 'none');
});

test('serp_audit live path uses the injected fetcher only when live=true', async () => {
  const { db } = fakeDb();
  let called = false;
  const fetchSerp = async () => { called = true; return [{ title: 'x', url: 'https://centurionfinancial.com', rank: 1 }]; };
  const res = await make(db, { fetchSerp })(env('serp_audit', { query: 'q', live: true, ownedDomains: ['centurionfinancial.com'] }));
  assert.equal(called, true);
  assert.equal(res.artifacts[0].data.source, 'live');
  assert.equal(res.artifacts[0].data.owned_in_top10, 1);
});

test('knowledge_panel builds a claim payload + checklist, never submits', async () => {
  const { db, calls } = fakeDb();
  const org = await make(db, {})(env('knowledge_panel', { kind: 'org' }));
  assert.equal(org.status, 'ok');
  assert.equal(org.artifacts[0].data.kind, 'Organization');
  assert.equal(org.artifacts[0].data.submit, false);
  assert.ok(org.artifacts[0].data.checklist.length >= 4);
  const person = await make(db, {})(env('knowledge_panel', { kind: 'person', person: 'ashton-couture' }));
  assert.equal(person.artifacts[0].data.kind, 'Person');
  assert.equal(person.artifacts[0].data.submit, false);
  assert.ok(calls.events.some((e) => e.event_type === 'panel.claim_built'));
});

test('scheduled mode (EventBridge monthly SERP) is accepted as a system actor', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db, {})(env('coverage_audit', {}, { mode: 'scheduled', __userToken: undefined }));
  assert.equal(res.status, 'ok');
  assert.equal(calls.runs[0].actor_user_id, 'system:scheduler');
});

test('kill switch engaged -> killed before any generation', async () => {
  const { db, calls } = fakeDb({ readControls: async () => [{ scope: 'global', state: 'kill' }] });
  const res = await make(db, {})(env('coverage_audit', {}));
  assert.equal(res.status, 'killed');
  assert.equal(calls.coverage.length, 0);
  assert.ok(calls.events.some((e) => e.event_type === 'kill_switch.engaged'));
});

test('controls unreachable -> fail closed (refused)', async () => {
  const { db, calls } = fakeDb({ readControls: async () => { throw new Error('down'); } });
  const res = await make(db, {})(env('coverage_audit', {}));
  assert.equal(res.status, 'refused');
  assert.match(res.reply, /controls_unreachable/);
  assert.equal(calls.coverage.length, 0);
});

test('peer call from an unknown caller is refused (ALLOWED_CALLERS empty at P1)', async () => {
  const { db } = fakeDb();
  const res = await make(db, {})(env('coverage_audit', {}, { trace: { chain: ['mallory'] }, __userToken: undefined }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.status, 'refused');
});

test('unknown task and bad mode are 400s', async () => {
  const { db } = fakeDb();
  assert.equal((await make(db, {})(env('do_crimes', {}))).statusCode, 400);
  assert.equal((await make(db, {})(env('coverage_audit', {}, { mode: 'yolo' }))).statusCode, 400);
});
