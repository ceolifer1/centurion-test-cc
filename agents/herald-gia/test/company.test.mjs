// Handler-level: kill-switch refuses FIRST (fail closed - the task never runs),
// manage_company_page routes a draft through the Vera gate into the content queue
// WITHOUT posting (company-page posting needs the pending Community Management API
// approval), and the manifest advertises the compliant official-API surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, MANIFEST } from '../src/index.mjs';
import { CAPS_VERSION } from '../src/caps.mjs';
import { fakeDb, fakeLinkedInFetch, veraPass, veraBounce, CURATED, VALID_NOW } from './fixtures.mjs';

// A peer-chain envelope (Cass -> Gia): no JWT, caller proven by chain last elem.
const peerEvent = (task, payload) => ({ runId: 'h1', mode: 'task', task, payload, trace: { chain: ['cass'] } });

test('kill switch engaged -> killed FIRST, the task never runs (no engagement, no reserve)', async () => {
  const { db, calls } = fakeDb({ readControls: async () => [{ scope: 'global', state: 'kill' }] });
  const li = fakeLinkedInFetch();
  const handler = createHandler({ makeDb: async () => db, now: VALID_NOW, taskDeps: { fetch: li.fetchImpl } });
  const res = await handler(peerEvent('engage', { person: 'ashton-couture', platform: 'linkedin_personal', targets: [CURATED] }));
  assert.equal(res.status, 'killed');
  assert.equal(calls.engagements.length, 0, 'task body never executed under kill');
  assert.equal(calls.reserves.length, 0);
  assert.equal(li.calls.reactions.length, 0);
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
  const res = await handler(peerEvent('engage', { person: 'ashton-couture', platform: 'linkedin_personal', targets: [CURATED] }));
  assert.equal(res.status, 'refused');
});

test('manage_company_page: clean draft PASSES Vera -> content queue vera_pass, and does NOT post', async () => {
  const { db, calls } = fakeDb();
  const li = fakeLinkedInFetch();
  const handler = createHandler({ makeDb: async () => db, now: VALID_NOW, taskDeps: { callVera: veraPass, fetch: li.fetchImpl } });
  const res = await handler(peerEvent('manage_company_page',
    { person: 'ashton-couture', body: 'Centurion Financial, founded 2021. We build capital-access infrastructure.' }));
  assert.equal(res.status, 'ok');
  assert.equal(res.verdict, 'pass');
  const q = calls.queue[0];
  assert.equal(q.platform, 'linkedin_company');
  assert.equal(q.created_by, 'gia');
  assert.ok(calls.queuePatches.some((p) => p.status === 'vera_pass'));
  assert.equal(li.calls.reactions.length + li.calls.comments.length, 0, 'company-page draft is queue-only, never posted');
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

test('manifest advertises the compliant official-API surface + caps.json wired', () => {
  assert.deepEqual(MANIFEST.capabilities, ['engage', 'manage_company_page', 'enqueue_follow']);
  assert.equal(MANIFEST.variant, 'lambda');
  assert.equal(MANIFEST.transport_to_linkedin, 'official_rest_api');
  assert.equal(MANIFEST.api.scope, 'w_member_social_feed');
  assert.match(MANIFEST.api.reactions, /\/rest\/reactions/);
  assert.match(MANIFEST.api.comments, /\/rest\/socialActions\//);
  assert.equal(MANIFEST.engage_mode, 'curated_targets_only');
  assert.equal(MANIFEST.company_page, 'queue_only_pending_cm_api');
  assert.equal(MANIFEST.follows, 'human_tap_only');
  assert.match(CAPS_VERSION, /spec-d/);
});
