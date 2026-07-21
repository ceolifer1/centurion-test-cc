// Follows are DISABLED for automation: enqueue_follow ALWAYS writes a human-tap
// queue row (never auto-follow), never reserves a follow cap, and never marks a
// follow executed. One-tap human execution only (SPEC-D 4/6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueFollow } from '../src/tasks.mjs';
import { fakeDb, VALID_NOW } from './fixtures.mjs';

const WARM = { ref: 'https://linkedin.com/in/known', kind: 'profile', relationship: 'connection' };
const COLD = { ref: 'https://linkedin.com/in/stranger', kind: 'profile' };

test('enqueue_follow (LinkedIn) -> human_tap row, NEVER auto: no reserve, no execute', async () => {
  const { db, calls } = fakeDb();
  const out = await enqueueFollow({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', target: WARM },
    runId: 'f1', db, now: VALID_NOW() });
  assert.equal(out.status, 'ok');
  assert.equal(out.payloadOut.human_tap, true);
  assert.equal(out.payloadOut.auto, false);
  assert.equal(calls.reserves.length, 0, 'a follow NEVER reserves a cap');
  assert.equal(calls.commits.length, 0);
  assert.equal(calls.engagements[0].status, 'human_tap');
  assert.equal(calls.engagements[0].action_class, 'follow');
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

test('enqueue_follow records warmth when known, still human-tap for a cold target', async () => {
  const { db, calls } = fakeDb();
  const out = await enqueueFollow({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', target: COLD },
    runId: 'f3', db, now: VALID_NOW() });
  assert.equal(out.status, 'ok');
  assert.equal(calls.engagements[0].status, 'human_tap');
  assert.equal(calls.engagements[0].warm_reason, null);
});

test('enqueue_follow requires a target ref/handle/urn', async () => {
  const { db } = fakeDb();
  const out = await enqueueFollow({ payload: { person: 'ashton-couture', platform: 'x', target: {} }, runId: 'f4', db, now: VALID_NOW() });
  assert.equal(out.status, 'error');
});
