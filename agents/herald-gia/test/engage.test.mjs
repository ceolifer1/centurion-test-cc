// engage (OFFICIAL API): warm/curated-only, Vera-gated comments, SPEC-D
// reserve-then-act, the DRY-RUN wall (no API unless HERALD_LIVE), and the
// Community-Management approval gate (no API unless the token carries
// w_member_social_feed). The LinkedIn API, token vault, Vera peer, and Supabase
// are all mocked - node --test, zero installed deps, NEVER hits real LinkedIn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engage } from '../src/tasks.mjs';
import {
  fakeDb, fakeLinkedInFetch, veraPass, veraBounce,
  TOKEN_FEED, TOKEN_NOFEED, CURATED, WARM_TOPIC, COLD_TARGET, VALID_NOW,
} from './fixtures.mjs';

test('DRY-RUN default (flag off): NO LinkedIn API call, reservation released, would-engage recorded', async () => {
  const { db, calls } = fakeDb();
  const li = fakeLinkedInFetch();
  const out = await engage({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', targets: [CURATED] },
    runId: 'r1', db, now: VALID_NOW(), deps: { callVera: veraPass, fetch: li.fetchImpl } });
  assert.equal(out.status, 'ok');
  assert.equal(li.calls.reactions.length, 0, 'NEVER calls the reactions API in dry-run');
  assert.equal(calls.commits.length, 0, 'no slot committed on a rehearsal');
  assert.equal(calls.rollbacks.length, 1, 'reservation released on a rehearsal');
  assert.equal(calls.engagements[0].status, 'cleared');
  assert.ok(calls.events.some((e) => e.event_type === 'engagement.would_engage' && e.payload.dry_run === true));
});

test('warm-only: a COLD target is skipped - never engaged, never reserved, no API', async () => {
  const { db, calls } = fakeDb();
  const li = fakeLinkedInFetch();
  const out = await engage({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', targets: [COLD_TARGET] },
    runId: 'r2', db, now: VALID_NOW(), deps: { live: true, getSecret: async () => TOKEN_FEED, fetch: li.fetchImpl } });
  assert.equal(out.status, 'ok');
  assert.equal(out.payloadOut.engaged, 0);
  assert.equal(out.payloadOut.skipped, 1);
  assert.equal(calls.reserves.length, 0, 'cold target never reserves a cap');
  assert.equal(calls.engagements.length, 0, 'cold target never records a row');
  assert.equal(li.calls.reactions.length, 0);
  assert.ok(calls.events.some((e) => e.event_type === 'engagement.skipped' && e.payload.reason === 'not_warm'));
});

test('LIVE reaction: warm target + feed scope => POST /rest/reactions once, commit, executed row', async () => {
  const { db, calls } = fakeDb();
  const li = fakeLinkedInFetch();
  const out = await engage({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', targets: [CURATED] },
    runId: 'r3', db, now: VALID_NOW(), deps: { live: true, getSecret: async () => TOKEN_FEED, fetch: li.fetchImpl } });
  assert.equal(out.status, 'ok');
  assert.equal(li.calls.reactions.length, 1, 'exactly one real reaction');
  assert.equal(li.calls.reactions[0].body.root, CURATED.urn);
  assert.equal(li.calls.userinfo, 0, 'actor URN came from the vaulted envelope, no userinfo call');
  assert.equal(calls.commits.length, 1, 'slot committed on a real reaction');
  assert.equal(calls.engagements[0].status, 'executed');
  assert.ok(calls.engagements[0].external_ref, 'external_ref (reaction URN) recorded');
  assert.ok(calls.events.some((e) => e.event_type === 'engagement.executed' && e.payload.dry_run === false));
});

test('LIVE comment: Vera PASS => POST /rest/socialActions/{urn}/comments once, commit, executed', async () => {
  const { db, calls } = fakeDb();
  const li = fakeLinkedInFetch();
  const target = { urn: 'urn:li:activity:7100000000000000050', action: 'comment', body: 'Congratulations on the milestone.', curated: true };
  const out = await engage({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', targets: [target] },
    runId: 'r4', db, now: VALID_NOW(), deps: { live: true, getSecret: async () => TOKEN_FEED, fetch: li.fetchImpl, callVera: veraPass } });
  assert.equal(out.status, 'ok');
  assert.equal(li.calls.comments.length, 1, 'exactly one real comment');
  assert.equal(li.calls.comments[0].body.message.text, 'Congratulations on the milestone.');
  assert.equal(calls.commits.length, 1);
  assert.equal(calls.engagements[0].action_class, 'comment');
  assert.equal(calls.engagements[0].status, 'executed');
});

test('Vera BOUNCE on a comment => that engagement is skipped, cap untouched, NO API', async () => {
  const { db, calls } = fakeDb();
  const li = fakeLinkedInFetch();
  const target = { urn: 'urn:li:activity:7100000000000000051', action: 'comment', body: 'We have $2B AUM and guaranteed returns.', curated: true };
  const out = await engage({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', targets: [target] },
    runId: 'r5', db, now: VALID_NOW(), deps: { live: true, getSecret: async () => TOKEN_FEED, fetch: li.fetchImpl, callVera: veraBounce(['VERA-T01']) } });
  assert.equal(out.status, 'ok');
  assert.equal(out.payloadOut.engaged, 0);
  assert.equal(calls.reserves.length, 0, 'a bounced comment never reserves a cap');
  assert.equal(li.calls.comments.length, 0, 'a bounced comment never posts');
  assert.ok(calls.events.some((e) => e.event_type === 'engagement.bounced'));
});

test('caps exceeded => HARD-STOP: whole run halts, nothing engaged, NO API (even armed live)', async () => {
  const { db, calls } = fakeDb({ reserveAction: async () => ({ allowed: false, reason: 'cap', window: 'day' }) });
  const li = fakeLinkedInFetch();
  const out = await engage({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', targets: [CURATED] },
    runId: 'r6', db, now: VALID_NOW(), deps: { live: true, getSecret: async () => TOKEN_FEED, fetch: li.fetchImpl } });
  assert.equal(out.status, 'caps_stop');
  assert.equal(li.calls.reactions.length, 0);
  assert.equal(calls.commits.length, 0);
  assert.ok(calls.events.some((e) => e.event_type === 'caps.stop' && e.payload.hard_stop === true));
});

test('APPROVAL GATE: live but token lacks w_member_social_feed => NO API call, gated (proposed), slot released', async () => {
  const { db, calls } = fakeDb();
  const li = fakeLinkedInFetch();
  const out = await engage({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', targets: [CURATED] },
    runId: 'r7', db, now: VALID_NOW(), deps: { live: true, getSecret: async () => TOKEN_NOFEED, fetch: li.fetchImpl } });
  assert.equal(out.status, 'ok');
  assert.equal(li.calls.reactions.length, 0, 'no scope => no API call (would 403)');
  assert.equal(calls.rollbacks.length, 1, 'gated action releases its reservation');
  assert.equal(calls.commits.length, 0);
  assert.equal(calls.engagements[0].status, 'proposed');
  assert.ok(calls.events.some((e) => e.event_type === 'engagement.gated' && e.payload.gate === 'needs_scope' && e.payload.required_scope === 'w_member_social_feed'));
});

test('token read is mocked + missing token (live) => NO API, token.invalid audited, gated', async () => {
  const { db, calls } = fakeDb();
  const li = fakeLinkedInFetch();
  const out = await engage({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', targets: [CURATED] },
    runId: 'r8', db, now: VALID_NOW(), deps: { live: true, getSecret: async () => { const e = new Error('gone'); e.notFound = true; throw e; }, fetch: li.fetchImpl } });
  assert.equal(out.status, 'ok');
  assert.equal(li.calls.reactions.length, 0);
  assert.ok(calls.events.some((e) => e.event_type === 'token.invalid' && e.payload.reason === 'no_secret'));
  assert.equal(calls.engagements[0].status, 'proposed');
});

test('multi-target: warm reaction executes, cold target skipped (curated-list, one API call)', async () => {
  const { db, calls } = fakeDb();
  const li = fakeLinkedInFetch();
  const out = await engage({ payload: { person: 'ashton-couture', platform: 'linkedin_personal', targets: [CURATED, COLD_TARGET, WARM_TOPIC] },
    runId: 'r9', db, now: VALID_NOW(), deps: { live: true, getSecret: async () => TOKEN_FEED, fetch: li.fetchImpl } });
  assert.equal(out.status, 'ok');
  assert.equal(out.payloadOut.engaged, 2, 'CURATED + WARM_TOPIC engaged');
  assert.equal(out.payloadOut.skipped, 1, 'COLD skipped');
  assert.equal(li.calls.reactions.length, 2);
});
