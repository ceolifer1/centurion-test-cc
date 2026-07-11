// Handler contract: manifest shape, kill-state refusal, fail-closed controls,
// peer vs dashboard auth, chain rules, kill_switch admin gate, watch_live
// drift + escalation, and the AGT-3 event/usage writes on every invoke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, MANIFEST } from '../src/index.mjs';
import { ASHTON } from './fixtures.mjs';

function fakeDb(overrides = {}) {
  const calls = { events: [], usage: [], runs: [], controls: [], queuePatches: [] };
  const db = {
    readControls: async () => [{ scope: 'global', state: 'run' }],
    upsertControl: async (row) => { calls.controls.push(row); },
    insertEvent: async (row) => { calls.events.push(row); },
    insertUsage: async (row) => { calls.usage.push(row); },
    insertRun: async (row) => { calls.runs.push(row); },
    patchRun: async () => {},
    getQueueItem: async () => null,
    patchQueueItem: async (id, row) => { calls.queuePatches.push({ id, ...row }); },
    getFactFile: async () => ({ person_id: 'ashton-couture', data: ASHTON, version: 1 }),
    ...overrides,
  };
  return { db, calls };
}

const peerEnvelope = (extra = {}) => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'task',
  task: 'review_content',
  actor: { userId: 'system' },
  payload: { content: { person: 'ashton-couture', platform: 'linkedin_personal', kind: 'post', body: 'A quiet, factual institutional update.' } },
  trace: { chain: ['nico'] },
  ...extra,
});

const make = (db, deps = {}) => createHandler({ makeDb: async () => db, now: () => '2026-07-11T00:00:00Z', ...deps });

test('GET /manifest returns the AGT-2 shape', async () => {
  const { db } = fakeDb();
  const handler = make(db);
  const res = await handler({ requestContext: { http: { method: 'GET' } }, rawPath: '/manifest' });
  assert.equal(res.statusCode, 200);
  const m = JSON.parse(res.body);
  assert.equal(m.service, 'herald-vera');
  assert.equal(m.agent, 'vera');
  assert.equal(m.engine, 'herald');
  assert.deepEqual(m.capabilities, ['review_content', 'watch_live', 'kill_switch']);
  assert.equal(m.variant, 'lambda');
  assert.ok(m.invoke.envelope.trace);
  assert.deepEqual(m.kill_switch_scopes, ['global', 'agent', 'user']);
  assert.equal(m.deterministic_only, true);
  assert.equal(MANIFEST.models.default, 'claude-sonnet-5');
});

test('kill state refuses before any work (fail-closed gate first)', async () => {
  const { db, calls } = fakeDb({ readControls: async () => [{ scope: 'global', state: 'kill' }] });
  const res = await make(db)(peerEnvelope());
  assert.equal(res.statusCode, 200);
  assert.equal(res.status, 'killed');
  assert.ok(calls.events.some((e) => e.event_type === 'kill_enforced'));
});

test('pause state refuses new work', async () => {
  const { db } = fakeDb({ readControls: async () => [{ scope: 'agent:vera', state: 'pause' }] });
  const res = await make(db)(peerEnvelope());
  assert.equal(res.status, 'refused');
});

test('controls unreachable -> fail closed (refused), never proceeds', async () => {
  const { db, calls } = fakeDb({ readControls: async () => { throw new Error('supabase down'); } });
  const res = await make(db)(peerEnvelope());
  assert.equal(res.status, 'refused');
  assert.match(res.reply, /controls_unreachable/);
  assert.equal(calls.events.length, 0); // no task ran
});

test('peer call (IAM-proven, no JWT) from an allowed caller runs the review', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db)(peerEnvelope());
  assert.equal(res.status, 'ok');
  assert.equal(res.verdict, 'pass');
  assert.equal(res.usage.costUsd, 0); // deterministic - no model call
  assert.ok(calls.events.some((e) => e.event_type === 'content.vera_pass'));
  assert.ok(calls.usage.length === 1 && calls.usage[0].service === 'herald-vera');
  assert.ok(calls.runs.length === 1 && calls.runs[0].agent === 'vera');
});

test('peer call from an unknown caller is refused (ALLOWED_CALLERS)', async () => {
  const { db } = fakeDb();
  const res = await make(db)(peerEnvelope({ trace: { chain: ['mallory'] } }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.status, 'refused');
});

test('chain cycle (vera already in chain) is refused', async () => {
  const { db } = fakeDb();
  const res = await make(db)(peerEnvelope({ trace: { chain: ['nico', 'vera', 'piper'] } }));
  assert.equal(res.status, 'refused');
  assert.match(res.error, /cycle/);
});

test('chain depth > 4 is refused', async () => {
  const { db } = fakeDb();
  const res = await make(db)(peerEnvelope({ trace: { chain: ['a', 'b', 'c', 'gia'] } }));
  assert.equal(res.status, 'refused');
  assert.match(res.error, /depth/);
});

test('kill_switch: admin dashboard actor flips herald_controls even when controls reads fail', async () => {
  const { db, calls } = fakeDb({ readControls: async () => { throw new Error('down'); } });
  const handler = make(db, { authorize: async () => ({ type: 'user', userId: 'u-1', email: 'ceo@centurionfinancial.com', role: 'super_admin' }) });
  const res = await handler({
    __userToken: 'jwt', runId: '22222222-2222-4222-8222-222222222222', mode: 'task', task: 'kill_switch',
    actor: { userId: 'u-1' }, payload: { scope: 'global', state: 'kill', reason: 'drill' }, trace: { chain: [] },
  });
  assert.equal(res.status, 'ok');
  assert.deepEqual(calls.controls[0].scope, 'global');
  assert.equal(calls.controls[0].state, 'kill');
  assert.ok(calls.events.some((e) => e.event_type === 'kill_switch.engaged'));
});

test('kill_switch: state=run emits kill_switch.released', async () => {
  const { db, calls } = fakeDb();
  const handler = make(db, { authorize: async () => ({ type: 'user', userId: 'u-1', email: 'ceo@centurionfinancial.com', role: 'admin' }) });
  const res = await handler({ __userToken: 'jwt', mode: 'task', task: 'kill_switch', payload: { state: 'run' }, trace: { chain: [] } });
  assert.equal(res.status, 'ok');
  assert.ok(calls.events.some((e) => e.event_type === 'kill_switch.released'));
});

test('kill_switch: non-admin actor is refused', async () => {
  const { db, calls } = fakeDb();
  const handler = make(db, { authorize: async () => ({ type: 'user', userId: 'u-2', email: 'user@centurionfinancial.com', role: 'employee' }) });
  const res = await handler({ __userToken: 'jwt', mode: 'task', task: 'kill_switch', payload: { state: 'kill' }, trace: { chain: [] } });
  assert.equal(res.status, 'refused');
  assert.equal(calls.controls.length, 0);
});

test('kill_switch: peer agents can never flip the switch', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db)({ mode: 'task', task: 'kill_switch', payload: { state: 'kill' }, trace: { chain: ['nico'] } });
  assert.equal(res.status, 'refused');
  assert.equal(calls.controls.length, 0);
});

test('review_content with contentId writes vera_verdict + status onto the queue row', async () => {
  const row = { id: 'q-1', person: 'ashton-couture', platform: 'linkedin_personal', kind: 'post', title: null, body: 'Our AUM is huge.' };
  const { db, calls } = fakeDb({ getQueueItem: async () => row });
  const res = await make(db)(peerEnvelope({ payload: { contentId: 'q-1' } }));
  assert.equal(res.status, 'ok');
  assert.equal(res.verdict, 'bounce');
  assert.equal(calls.queuePatches.length, 1);
  assert.equal(calls.queuePatches[0].status, 'bounced');
  assert.equal(calls.queuePatches[0].vera_verdict.verdict, 'bounce');
  assert.equal(calls.queuePatches[0].vera_verdict.model, 'deterministic');
  assert.equal(calls.queuePatches[0].vera_verdict.gates.length, 4);
  assert.ok(res.artifacts[0].data.rule_ids.includes('VERA-T01'));
  assert.ok(calls.events.some((e) => e.event_type === 'content.vera_bounce'));
});

test('watch_live: matching live content is ok, no escalation', async () => {
  const { db, calls } = fakeDb();
  const body = 'A quiet, factual institutional update.';
  const res = await make(db)(peerEnvelope({
    task: 'watch_live', trace: { chain: ['piper'] },
    payload: { person: 'ashton-couture', platform: 'linkedin_personal', approvedBody: body, live: { body: body + '  ' } },
  }));
  assert.equal(res.status, 'ok');
  assert.equal(calls.controls.length, 0);
  assert.ok(calls.events.some((e) => e.event_type === 'livewatch.ok'));
});

test('watch_live: numeric drift escalates - person scope paused + violation event', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db)(peerEnvelope({
    task: 'watch_live', trace: { chain: ['piper'] },
    payload: {
      person: 'ashton-couture', platform: 'linkedin_personal',
      approvedBody: 'Advised on transactions per our approved claim, 28 years across software, banking technology, and commercial finance.',
      live: { body: 'Advised on transactions per our approved claim, 31 years across software, banking technology, and commercial finance.' },
    },
  }));
  assert.equal(res.status, 'ok');
  assert.equal(calls.controls.length, 1);
  assert.equal(calls.controls[0].scope, 'user:ashton-couture');
  assert.equal(calls.controls[0].state, 'pause');
  assert.ok(calls.events.some((e) => e.event_type === 'livewatch.violation'));
});

test('watch_live: block-severity live hit escalates even without drift context', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db)(peerEnvelope({
    task: 'watch_live', trace: { chain: ['piper'] },
    payload: { person: 'ashton-couture', live: { body: 'Our AUM reached new highs.' } },
  }));
  assert.equal(res.status, 'ok');
  assert.equal(res.verdict, 'bounce');
  assert.equal(calls.controls[0].state, 'pause');
});

test('unknown task and bad mode are 400s', async () => {
  const { db } = fakeDb();
  const bad = await make(db)(peerEnvelope({ task: 'do_crimes' }));
  assert.equal(bad.statusCode, 400);
  const badMode = await make(db)(peerEnvelope({ mode: 'yolo' }));
  assert.equal(badMode.statusCode, 400);
});

test('every successful invoke writes exactly one usage-ledger row (service herald-vera, zero cost)', async () => {
  const { db, calls } = fakeDb();
  await make(db)(peerEnvelope());
  assert.equal(calls.usage.length, 1);
  assert.equal(calls.usage[0].est_cost_cents, 0);
  assert.equal(calls.usage[0].month, '2026-07');
});
