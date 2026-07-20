// Handler-level: kill-switch refuses FIRST (fail closed - task never runs), and
// manage_company_page routes a draft through the Vera gate into the content queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, MANIFEST } from '../src/index.mjs';
import { CAPS_VERSION } from '../src/caps.mjs';
import { fakeDb, veraPass, veraBounce, VALID_NOW } from './fixtures.mjs';

// A peer-chain envelope (Cass -> Gia): no JWT, caller proven by chain last elem.
const peerEvent = (task, payload) => ({ runId: 'h1', mode: 'task', task, payload, trace: { chain: ['cass'] } });

test('kill switch engaged -> killed FIRST, the task never runs (no engagement, no queue write)', async () => {
  const { db, calls } = fakeDb({ readControls: async () => [{ scope: 'global', state: 'kill' }] });
  const handler = createHandler({ makeDb: async () => db, now: VALID_NOW });
  const res = await handler(peerEvent('engage', { person: 'ashton-couture', platform: 'linkedin_personal', action: 'like',
    target: { ref: 'x', relationship: 'connection' } }));
  assert.equal(res.status, 'killed');
  assert.equal(calls.engagements.length, 0, 'task body never executed under kill');
  assert.equal(calls.reserves.length, 0);
  assert.ok(calls.events.some((e) => e.event_type === 'kill_switch.engaged' && e.payload.enforced === true));
});

test('pause switch -> refused FIRST', async () => {
  const { db, calls } = fakeDb({ readControls: async () => [{ scope: 'global', state: 'pause' }] });
  const handler = createHandler({ makeDb: async () => db, now: VALID_NOW });
  const res = await handler(peerEvent('enqueue_follow', { person: 'ashton-couture', platform: 'x', target: { handle: '@x' } }));
  assert.equal(res.status, 'refused');
  assert.equal(calls.engagements.length, 0);
});

test('controls unreachable -> refused (fail closed)', async () => {
  const handler = createHandler({ makeDb: async () => { throw new Error('db down'); }, now: VALID_NOW });
  const res = await handler(peerEvent('engage', { person: 'ashton-couture', platform: 'x', action: 'like', target: {} }));
  assert.equal(res.status, 'refused');
});

test('manage_company_page: clean draft PASSES Vera -> content queue row vera_pass', async () => {
  const { db, calls } = fakeDb();
  const handler = createHandler({ makeDb: async () => db, now: VALID_NOW, taskDeps: { callVera: veraPass } });
  const res = await handler(peerEvent('manage_company_page',
    { person: 'ashton-couture', body: 'Centurion Financial, founded 2021. We build capital-access infrastructure.' }));
  assert.equal(res.status, 'ok');
  assert.equal(res.verdict, 'pass');
  const q = calls.queue[0];
  assert.equal(q.platform, 'linkedin_company');
  assert.equal(q.created_by, 'gia');
  assert.ok(calls.queuePatches.some((p) => p.status === 'vera_pass'));
});

test('manage_company_page: a bad draft BOUNCES at the Vera gate -> bounced', async () => {
  const { db, calls } = fakeDb();
  const handler = createHandler({ makeDb: async () => db, now: VALID_NOW, taskDeps: { callVera: veraBounce(['VERA-T01']) } });
  const res = await handler(peerEvent('manage_company_page',
    { person: 'ashton-couture', body: 'We manage $2B AUM with guaranteed returns.' }));
  assert.equal(res.status, 'ok');
  assert.equal(res.verdict, 'bounce');
  assert.ok(calls.queuePatches.some((p) => p.status === 'bounced'));
});

test('unknown caller is refused (no JWT, caller not in ALLOWED_CALLERS)', async () => {
  const { db } = fakeDb();
  const handler = createHandler({ makeDb: async () => db, now: VALID_NOW });
  const res = await handler({ runId: 'h9', mode: 'task', task: 'engage', payload: {}, trace: { chain: ['rhea'] } });
  assert.equal(res.status, 'refused');
});

test('manifest + caps.json are wired', () => {
  assert.deepEqual(MANIFEST.capabilities, ['engage', 'manage_company_page', 'enqueue_follow']);
  assert.equal(MANIFEST.variant, 'lambda');
  assert.match(CAPS_VERSION, /spec-d/);
});
