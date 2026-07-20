// SPEC-D engage: WARM-ONLY filter (cold => skip, never reserve) and
// reserve-then-act with HARD-STOP (would-exceed => whole run stops, nothing
// cleared). Comment copy must pass the Vera gate before it can be cleared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engage } from '../src/tasks.mjs';
import { fakeDb, veraPass, veraBounce, WARM_CONNECTION, WARM_CRM, WARM_TOPIC, COLD_TARGET, VALID_NOW } from './fixtures.mjs';

test('warm-only filter: a COLD target is skipped - never engaged, never reserved', async () => {
  const { db, calls } = fakeDb();
  const out = await engage({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', action: 'like', target: COLD_TARGET },
    runId: 'r1', db, now: VALID_NOW() });
  assert.equal(out.status, 'ok');
  assert.equal(out.payloadOut.engaged, false);
  assert.equal(out.payloadOut.skipped, 'not_warm');
  assert.equal(calls.reserves.length, 0, 'cold target never reserves a cap');
  assert.equal(calls.engagements.length, 0, 'cold target never records an engagement');
  assert.ok(calls.events.some((e) => e.event_type === 'engagement.skipped' && e.payload.reason === 'not_warm'));
});

test('warm like (existing connection) clears: reserve-then-act, commit, engagement.cleared', async () => {
  const { db, calls } = fakeDb();
  const out = await engage({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', action: 'like', target: WARM_CONNECTION },
    runId: 'r2', db, now: VALID_NOW() });
  assert.equal(out.status, 'ok');
  assert.equal(out.payloadOut.engaged, true);
  assert.equal(out.payloadOut.warm_reason, 'connection');
  assert.equal(calls.reserves.length, 1, 'reserve-then-act: reserved before acting');
  assert.equal(calls.commits.length, 1, 'reservation committed on clear');
  assert.equal(calls.engagements.length, 1);
  assert.equal(calls.engagements[0].status, 'cleared');
  assert.equal(calls.engagements[0].warm_reason, 'connection');
  assert.ok(calls.events.some((e) => e.event_type === 'engagement.cleared' && e.payload.dry_run === true));
});

test('warm reasons: crm_partner and topic_graph both count as warm', async () => {
  for (const [target, reason] of [[WARM_CRM, 'crm_partner'], [WARM_TOPIC, 'topic_graph']]) {
    const { db } = fakeDb();
    const out = await engage({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', action: 'like', target },
      runId: 'r', db, now: VALID_NOW() });
    assert.equal(out.payloadOut.engaged, true);
    assert.equal(out.payloadOut.warm_reason, reason);
  }
});

test('caps HARD-STOP: a would-exceed reservation halts the whole run - nothing cleared', async () => {
  const { db, calls } = fakeDb({ reserveAction: async () => ({ allowed: false, reason: 'cap', window: 'day' }) });
  const out = await engage({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', action: 'like', target: WARM_CONNECTION },
    runId: 'r3', db, now: VALID_NOW() });
  assert.equal(out.status, 'caps_stop');
  assert.equal(out.payloadOut.reason, 'cap');
  assert.equal(calls.engagements.length, 0, 'no engagement cleared on hard-stop');
  assert.equal(calls.commits.length, 0);
  assert.ok(calls.events.some((e) => e.event_type === 'caps.stop' && e.payload.hard_stop === true));
});

test('caps HARD-STOP: X automated follow is DISABLED - engage on a disabled class hard-stops before any DB reserve', async () => {
  // reshare on X is capped, but a disabled/absent class hard-stops in caps.mjs.
  const { db, calls } = fakeDb();
  const out = await engage({ payload: { person: 'ashton-couture', platform: 'x', action: 'connect', target: WARM_CONNECTION },
    runId: 'r4', db, now: VALID_NOW() });
  // 'connect' is not a valid engage action -> validation error (never reserves).
  assert.equal(out.status, 'error');
  assert.equal(calls.reserves.length, 0);
});

test('comment engage: Vera BOUNCE blocks the comment - not cleared, cap untouched', async () => {
  const { db, calls } = fakeDb();
  const out = await engage({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', action: 'comment',
    body: 'We have $2B AUM and guaranteed returns.', target: WARM_CONNECTION },
    runId: 'r5', db, now: VALID_NOW(), deps: { callVera: veraBounce(['VERA-T01']) } });
  assert.equal(out.status, 'ok');
  assert.equal(out.payloadOut.engaged, false);
  assert.equal(out.payloadOut.skipped, 'vera_bounce');
  assert.equal(calls.reserves.length, 0, 'bounced comment never reserves a cap');
  assert.equal(calls.engagements.length, 0);
});

test('comment engage: Vera PASS then reserve+clear', async () => {
  const { db, calls } = fakeDb();
  const out = await engage({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', action: 'comment',
    body: 'Congratulations to the team on the milestone.', target: WARM_CONNECTION },
    runId: 'r6', db, now: VALID_NOW(), deps: { callVera: veraPass } });
  assert.equal(out.status, 'ok');
  assert.equal(out.payloadOut.engaged, true);
  assert.equal(calls.engagements.length, 1);
  assert.equal(calls.engagements[0].action_class, 'comment');
});
