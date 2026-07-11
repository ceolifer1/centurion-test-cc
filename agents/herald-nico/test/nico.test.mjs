// herald-nico contract + pipeline tests. All external boundaries (CF-prod db,
// the Anthropic model, the Vera peer invoke) are mocked - node --test, zero deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, MANIFEST } from '../src/index.mjs';
import { pickModel, costCentsFor } from '../src/router.mjs';
import { fakeDb, fakeModel, fakeVera, veraPass, veraBounce } from './fixtures.mjs';

const NOW = '2026-07-11T00:00:00Z';
const make = (db, taskDeps, extra = {}) =>
  createHandler({ makeDb: async () => db, now: () => NOW, taskDeps, ...extra });

const draftEnvelope = (payload, extra = {}) => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'task', task: 'draft_post', actor: { userId: 'system' },
  payload: { person: 'ashton-couture', platform: 'linkedin_personal', brief: 'Announce our institutional focus.', ...payload },
  trace: { chain: ['cass'] },
  ...extra,
});

test('GET /manifest returns the AGT-2 shape (nico, two capabilities, model router)', async () => {
  const { db } = fakeDb();
  const res = await make(db, {})({ requestContext: { http: { method: 'GET' } }, rawPath: '/manifest' });
  assert.equal(res.statusCode, 200);
  const m = JSON.parse(res.body);
  assert.equal(m.service, 'herald-nico');
  assert.deepEqual(m.capabilities, ['draft_post', 'redraft']);
  assert.equal(m.variant, 'lambda');
  assert.equal(m.deterministic_only, false);
  assert.equal(m.models.default, 'claude-sonnet-5');
  assert.equal(m.models.escalation, 'claude-opus-4-8');
  assert.equal(MANIFEST.engine, 'herald');
});

test('draft_post -> Vera PASS -> queue row written at vera_pass (run tier)', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db, { callModel: fakeModel(), callVera: fakeVera(veraPass()) })(draftEnvelope());
  assert.equal(res.status, 'ok');
  assert.equal(res.verdict, 'pass');
  // one draft row inserted, then patched to vera_pass with the verdict
  assert.equal(calls.queueInserts.length, 1);
  assert.equal(calls.queueInserts[0].status, 'draft');
  assert.equal(calls.queueInserts[0].tier, 'run');
  assert.equal(calls.queueInserts[0].created_by, 'nico');
  assert.equal(calls.queuePatches.length, 1);
  assert.equal(calls.queuePatches[0].status, 'vera_pass');
  assert.equal(calls.queuePatches[0].vera_verdict.verdict, 'pass');
  assert.ok(calls.events.some((e) => e.event_type === 'content.drafted'));
  assert.ok(calls.events.some((e) => e.event_type === 'content.vera_pass'));
  // real token cost flows to the ledger
  assert.equal(calls.usage.length, 1);
  assert.equal(calls.usage[0].service, 'herald-nico');
  assert.ok(calls.usage[0].est_cost_cents > 0);
  assert.ok(res.usage.costUsd > 0);
});

test('draft_post -> Vera BOUNCE -> row written at bounced with reasons, run stops', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db, { callModel: fakeModel('Our AUM is huge.'), callVera: fakeVera(veraBounce()) })(draftEnvelope());
  assert.equal(res.status, 'ok');
  assert.equal(res.verdict, 'bounce');
  assert.equal(calls.queuePatches[0].status, 'bounced');
  assert.deepEqual(calls.queuePatches[0].vera_verdict.rule_ids, ['VERA-T01']);
  assert.ok(calls.events.some((e) => e.event_type === 'content.vera_bounce'));
  // bounce artifact carries the reasons for the dashboard bounce callout
  assert.equal(res.artifacts[0].type, 'vera_verdict');
  assert.ok(res.artifacts[0].data.bounce_reasons.length >= 1);
});

test('crawl-tier person is stamped tier=crawl on the row', async () => {
  const { db, calls } = fakeDb({ getFactFile: async () => ({ data: { person_id: 'stephen-warren' } }) });
  await make(db, { callModel: fakeModel(), callVera: fakeVera(veraPass()) })(
    draftEnvelope({ person: 'stephen-warren' }, { trace: { chain: ['cass'] } }));
  assert.equal(calls.queueInserts[0].tier, 'crawl');
});

test('engine budget exhausted -> budget_exhausted, NO model call, NO queue row, budget_stop event', async () => {
  const { db, calls } = fakeDb({ monthSpendCents: async () => 40000 });
  let modelCalled = false;
  const res = await make(db, { callModel: async () => { modelCalled = true; return { text: 'x', model: 'claude-sonnet-5', usage: {}, costCents: 0 }; }, callVera: fakeVera(veraPass()) })(draftEnvelope());
  assert.equal(res.status, 'budget_exhausted');
  assert.equal(res.statusCode, 402);
  assert.equal(modelCalled, false);
  assert.equal(calls.queueInserts.length, 0);
  assert.ok(calls.events.some((e) => e.event_type === 'budget_stop'));
});

test('kill switch engaged -> killed before any work (fail-closed gate first)', async () => {
  const { db, calls } = fakeDb({ readControls: async () => [{ scope: 'global', state: 'kill' }] });
  let modelCalled = false;
  const res = await make(db, { callModel: async () => { modelCalled = true; return {}; }, callVera: fakeVera(veraPass()) })(draftEnvelope());
  assert.equal(res.status, 'killed');
  assert.equal(modelCalled, false);
  assert.equal(calls.queueInserts.length, 0);
  assert.ok(calls.events.some((e) => e.event_type === 'kill_switch.engaged'));
});

test('controls unreachable -> fail closed (refused), never drafts', async () => {
  const { db, calls } = fakeDb({ readControls: async () => { throw new Error('supabase down'); } });
  const res = await make(db, { callModel: fakeModel(), callVera: fakeVera(veraPass()) })(draftEnvelope());
  assert.equal(res.status, 'refused');
  assert.match(res.reply, /controls_unreachable/);
  assert.equal(calls.queueInserts.length, 0);
});

test('peer call from an unknown caller is refused (ALLOWED_CALLERS)', async () => {
  const { db } = fakeDb();
  const res = await make(db, { callModel: fakeModel(), callVera: fakeVera(veraPass()) })(
    draftEnvelope({}, { trace: { chain: ['mallory'] } }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.status, 'refused');
});

test('chain cycle (nico already in chain) is refused', async () => {
  const { db } = fakeDb();
  // Realistic cycle: last element (cass) is an allowed caller, but nico is
  // already earlier in the chain -> cycle guard fires after auth.
  const res = await make(db, {})(draftEnvelope({}, { trace: { chain: ['nico', 'cass'] } }));
  assert.equal(res.status, 'refused');
  assert.match(res.error, /cycle/);
});

test('redraft consumes a bounced row and re-enters the gate as a NEW row with parent_id', async () => {
  const bounced = {
    id: 'q-parent', person: 'ashton-couture', platform: 'linkedin_personal', kind: 'post',
    status: 'bounced', tier: 'run', body: 'Our AUM is huge.',
    vera_verdict: { bounce_reasons: ['VERA-T01: "AUM"'], suggested_rewrite: 'reframe as advisory volume' },
  };
  const { db, calls } = fakeDb({ getQueueItem: async () => bounced });
  const res = await make(db, { callModel: fakeModel('Advisory volume across a thousand transactions.'), callVera: fakeVera(veraPass()) })({
    runId: '22222222-2222-4222-8222-222222222222', mode: 'task', task: 'redraft',
    actor: { userId: 'system' }, payload: { bouncedId: 'q-parent' }, trace: { chain: ['cass'] },
  });
  assert.equal(res.status, 'ok');
  assert.equal(res.verdict, 'pass');
  assert.equal(calls.queueInserts[0].parent_id, 'q-parent');
  assert.equal(calls.queueInserts[0].status, 'draft');
  assert.ok(calls.events.some((e) => e.event_type === 'content.redrafted'));
});

test('router escalates to Opus for redrafts and hard/long briefs; Sonnet by default', () => {
  assert.equal(pickModel({ brief: 'short', kind: 'post' }), 'claude-sonnet-5');
  assert.equal(pickModel({ brief: 'short', kind: 'post', isRedraft: true }), 'claude-opus-4-8');
  assert.equal(pickModel({ brief: 'x'.repeat(1000) }), 'claude-opus-4-8');
  assert.equal(pickModel({ kind: 'tombstone' }), 'claude-opus-4-8');
  assert.ok(costCentsFor('claude-opus-4-8', { input_tokens: 1e6, output_tokens: 0 }) === 1500);
});

test('unknown task and bad mode are 400s', async () => {
  const { db } = fakeDb();
  assert.equal((await make(db, {})(draftEnvelope({}, { task: 'do_crimes' }))).statusCode, 400);
  assert.equal((await make(db, {})(draftEnvelope({}, { mode: 'yolo' }))).statusCode, 400);
});
