// Handler: manifest, kill-switch-first, scheduled system invoke (transport-authed
// by the scheduler role's IAM), unauthenticated HTTP refusal, and unknown task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, MANIFEST } from '../src/index.mjs';
import { fakeDb, fakeLinkedInFetch, VERA_PASS, TOKEN_ENVELOPE, VERA_PASS_ITEM } from './fixtures.mjs';

const mkHandler = (db, taskDeps = {}) => createHandler({ makeDb: () => db, taskDeps });

test('GET /manifest returns 200 with the official-API capabilities', async () => {
  const { db } = fakeDb();
  const h = mkHandler(db);
  const res = await h({ requestContext: { http: { method: 'GET' } }, rawPath: '/manifest', headers: {} });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(MANIFEST.capabilities, ['publish', 'publish_due', 'refresh_tokens']);
  assert.equal(MANIFEST.api.scope, 'w_member_social');
  assert.equal(MANIFEST.api.endpoint, 'POST https://api.linkedin.com/rest/posts');
});

test('scheduled direct invoke (no bearer, mode=scheduled) is system-authed and runs publish_due in dry-run', async () => {
  const { db, calls } = fakeDb({ listDue: async () => [VERA_PASS_ITEM()] });
  const li = fakeLinkedInFetch();
  const h = mkHandler(db, { getSecret: async () => TOKEN_ENVELOPE, reviewContent: VERA_PASS, checkKill: async () => ({ ok: true, action: 'run' }), fetch: li.fetchImpl });
  const res = await h({ mode: 'scheduled', task: 'publish_due', payload: {}, trace: { chain: [] } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.status, 'ok');
  assert.equal(li.calls.posts.length, 0, 'scheduled sweep never posts with HERALD_LIVE off');
  assert.ok(calls.events.some((e) => e.event_type === 'linkedin.publish_due.ok'));
});

test('kill switch in controls => killed, task never runs', async () => {
  const { db } = fakeDb({ readControls: async () => [{ scope: 'global', state: 'kill' }] });
  const h = mkHandler(db);
  const res = await h({ mode: 'scheduled', task: 'publish_due', payload: {} });
  assert.equal(res.status, 'killed');
});

test('HTTP POST with no bearer and no allowed caller => 401 refused', async () => {
  const { db } = fakeDb();
  const h = mkHandler(db);
  const res = await h({ requestContext: { http: { method: 'POST' } }, rawPath: '/invoke', headers: {}, body: JSON.stringify({ task: 'publish_due', mode: 'task' }) });
  assert.equal(res.statusCode, 401);
});

test('unknown task => 400', async () => {
  const { db } = fakeDb();
  const h = mkHandler(db);
  const res = await h({ mode: 'scheduled', task: 'nuke_everything', payload: {} });
  assert.equal(res.statusCode, 400);
});
