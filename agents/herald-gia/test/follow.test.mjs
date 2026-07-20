// SPEC-D follows are DISABLED for automation: enqueue_follow ALWAYS writes a
// human-tap queue row (never auto-follow), never reserves a follow cap, and never
// marks a follow cleared/executed. This is the hard "one-tap human execution"
// path (SPEC-D 4/6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueFollow } from '../src/tasks.mjs';
import { fakeDb, WARM_CONNECTION, COLD_TARGET, VALID_NOW } from './fixtures.mjs';

test('enqueue_follow (LinkedIn) -> human_tap row, NEVER auto: no reserve, no clear/execute', async () => {
  const { db, calls } = fakeDb();
  const out = await enqueueFollow({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', target: WARM_CONNECTION },
    runId: 'f1', db, now: VALID_NOW() });
  assert.equal(out.status, 'ok');
  assert.equal(out.payloadOut.human_tap, true);
  assert.equal(out.payloadOut.auto, false);
  assert.equal(calls.reserves.length, 0, 'a follow NEVER reserves a cap (never automated)');
  assert.equal(calls.commits.length, 0);
  assert.equal(calls.engagements.length, 1);
  assert.equal(calls.engagements[0].status, 'human_tap');
  assert.equal(calls.engagements[0].action_class, 'follow');
  // Never a cleared/executed state for a follow.
  assert.notEqual(calls.engagements[0].status, 'cleared');
  assert.notEqual(calls.engagements[0].status, 'executed');
  assert.ok(calls.events.some((e) => e.event_type === 'engagement.human_tap' && e.payload.auto === false));
});

test('enqueue_follow (X, automation disabled) -> human_tap, never auto', async () => {
  const { db, calls } = fakeDb();
  const out = await enqueueFollow({ payload: { person: 'ashton-couture', platform: 'x', target: { handle: '@centurionfin' } },
    runId: 'f2', db, now: VALID_NOW() });
  assert.equal(out.status, 'ok');
  assert.equal(out.payloadOut.human_tap, true);
  assert.equal(calls.reserves.length, 0);
  assert.equal(calls.engagements[0].status, 'human_tap');
  assert.equal(calls.engagements[0].target_ref, '@centurionfin');
});

test('enqueue_follow records warmth when known, but still human-tap for a cold target', async () => {
  const { db, calls } = fakeDb();
  const out = await enqueueFollow({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', target: COLD_TARGET },
    runId: 'f3', db, now: VALID_NOW() });
  assert.equal(out.status, 'ok');
  assert.equal(calls.engagements[0].status, 'human_tap');
  assert.equal(calls.engagements[0].warm_reason, null);
});

test('enqueue_follow requires a target ref/handle', async () => {
  const { db } = fakeDb();
  const out = await enqueueFollow({ payload: { person: 'ashton-couture', platform: 'x', target: {} }, runId: 'f4', db, now: VALID_NOW() });
  assert.equal(out.status, 'error');
});
