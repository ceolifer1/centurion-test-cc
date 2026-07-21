// herald-linkedin publish gauntlet: kill-check first, Vera re-verify on the EXACT
// final text, reserve-then-act caps, and the DRY-RUN wall (no API call unless
// HERALD_LIVE). The LinkedIn API, KMS/Secrets vault, Vera peer, and Supabase are
// all mocked - node --test, zero installed deps, NEVER hits real LinkedIn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishItem, publishDue, refreshTokens } from '../src/publish.mjs';
import {
  fakeDb, fakeLinkedInFetch, VERA_PASS, VERA_BOUNCE, VERA_PASS_ITEM,
  TOKEN_ENVELOPE, EXPIRED_TOKEN_ENVELOPE, VALID_NOW,
} from './fixtures.mjs';

const baseDeps = (over = {}) => ({
  getSecret: async () => TOKEN_ENVELOPE,
  reviewContent: VERA_PASS,
  checkKill: async () => ({ ok: true, action: 'run' }),
  ...over,
});

test('DRY-RUN default: flag off => NO LinkedIn API call, slot released, would_post recorded', async () => {
  const { db, calls } = fakeDb();
  const li = fakeLinkedInFetch();
  const out = await publishItem({ db, item: VERA_PASS_ITEM(), runId: 'r-1', now: VALID_NOW,
    deps: baseDeps({ fetch: li.fetchImpl }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.dryRun, true);
  assert.equal(li.calls.posts.length, 0, 'NEVER calls /rest/posts in dry-run');
  assert.match(out.externalRef, /^dryrun:/);
  assert.equal(calls.commits.length, 0, 'no slot committed on a rehearsal');
  assert.equal(calls.rollbacks.length, 1, 'reservation released on a rehearsal');
  assert.equal(calls.queuePatches.some((p) => p.status === 'posted'), false, 'row NOT marked posted in dry-run');
  assert.ok(calls.events.some((e) => e.event_type === 'content.would_post' && e.payload.dry_run === true));
});

test('kill switch => killed BEFORE any token fetch or API call', async () => {
  const { db, calls } = fakeDb();
  const li = fakeLinkedInFetch();
  let tokenFetched = false;
  const out = await publishItem({ db, item: VERA_PASS_ITEM(), runId: 'r-2', now: VALID_NOW,
    deps: baseDeps({ live: true, fetch: li.fetchImpl, checkKill: async () => ({ ok: false, action: 'kill', reason: 'kill' }),
      getSecret: async () => { tokenFetched = true; return TOKEN_ENVELOPE; } }) });
  assert.equal(out.status, 'killed');
  assert.equal(tokenFetched, false);
  assert.equal(li.calls.posts.length, 0);
  assert.ok(calls.events.some((e) => e.event_type === 'kill_switch.engaged'));
});

test('Vera bounce on the EXACT final text => NO post, row bounced', async () => {
  const { db, calls } = fakeDb();
  const li = fakeLinkedInFetch();
  const out = await publishItem({ db, item: VERA_PASS_ITEM(), runId: 'r-3', now: VALID_NOW,
    deps: baseDeps({ live: true, fetch: li.fetchImpl, reviewContent: VERA_BOUNCE }) });
  assert.equal(out.status, 'refused');
  assert.equal(out.reason, 'vera_bounce');
  assert.equal(li.calls.posts.length, 0, 'a bounced re-verify never posts');
  assert.ok(calls.queuePatches.some((p) => p.status === 'bounced'));
  assert.ok(calls.events.some((e) => e.event_type === 'content.vera_bounce' && e.payload.phase === 're_verify'));
});

test('caps hard-stop => aborts the whole run, no post (even armed live)', async () => {
  const { db, calls } = fakeDb({ reserveAction: async () => ({ allowed: false, reason: 'cap', window: 'day' }) });
  const li = fakeLinkedInFetch();
  const out = await publishItem({ db, item: VERA_PASS_ITEM(), runId: 'r-4', now: VALID_NOW,
    deps: baseDeps({ live: true, fetch: li.fetchImpl }) });
  assert.equal(out.status, 'caps_stop');
  assert.equal(out.reason, 'cap');
  assert.equal(li.calls.posts.length, 0);
  assert.ok(calls.events.some((e) => e.event_type === 'caps.stop' && e.payload.hard_stop === true));
});

test('LIVE happy path: posts to /rest/posts with correct headers+body, commits caps, marks posted with permalink', async () => {
  const { db, calls } = fakeDb();
  const li = fakeLinkedInFetch();
  const out = await publishItem({ db, item: VERA_PASS_ITEM(), runId: 'r-5', now: VALID_NOW,
    deps: baseDeps({ live: true, fetch: li.fetchImpl }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.dryRun, false);
  assert.equal(li.calls.posts.length, 1, 'exactly one real post');
  const p = li.calls.posts[0];
  assert.equal(p.headers['X-Restli-Protocol-Version'], '2.0.0');
  assert.ok(p.headers['LinkedIn-Version'], 'LinkedIn-Version header present');
  assert.match(p.headers.Authorization, /^Bearer /);
  assert.equal(p.body.author, 'urn:li:person:ABC123');
  assert.equal(p.body.visibility, 'PUBLIC');
  assert.equal(p.body.lifecycleState, 'PUBLISHED');
  assert.equal(p.body.distribution.feedDistribution, 'MAIN_FEED');
  assert.equal(p.body.commentary, VERA_PASS_ITEM().body);
  assert.equal(calls.commits.length, 1, 'slot committed on a real post');
  const posted = calls.queuePatches.find((x) => x.status === 'posted');
  assert.ok(posted && /linkedin\.com\/feed\/update\/urn:li:share:/.test(posted.external_ref));
  assert.ok(calls.events.some((e) => e.event_type === 'content.posted' && e.payload.dry_run === false));
});

test('no vaulted token (never authorized) => token_invalid, no post', async () => {
  const { db, calls } = fakeDb();
  const li = fakeLinkedInFetch();
  const out = await publishItem({ db, item: VERA_PASS_ITEM(), runId: 'r-6', now: VALID_NOW,
    deps: baseDeps({ live: true, fetch: li.fetchImpl, getSecret: async () => { const e = new Error('gone'); e.notFound = true; throw e; } }) });
  assert.equal(out.status, 'token_invalid');
  assert.equal(out.reason, 'no_secret');
  assert.equal(li.calls.posts.length, 0);
  assert.ok(calls.events.some((e) => e.event_type === 'token.invalid'));
});

test('expired access token => inline refresh, then LIVE post with the NEW token', async () => {
  const { db } = fakeDb();
  const li = fakeLinkedInFetch();
  let putEnvelope = null;
  const out = await publishItem({ db, item: VERA_PASS_ITEM(), runId: 'r-7', now: VALID_NOW,
    deps: baseDeps({ live: true, fetch: li.fetchImpl, getSecret: async () => EXPIRED_TOKEN_ENVELOPE,
      putSecret: async (arn, val) => { putEnvelope = JSON.parse(val); } }) });
  assert.equal(out.status, 'ok');
  assert.equal(li.calls.oauth.length, 1, 'refreshed the token');
  assert.match(li.calls.oauth[0].body, /grant_type=refresh_token/);
  assert.equal(li.calls.posts.length, 1);
  assert.match(li.calls.posts[0].headers.Authorization, /Bearer NEW-ACCESS-TOKEN/);
  assert.ok(putEnvelope && putEnvelope.access_token === 'NEW-ACCESS-TOKEN', 'new token written back to the vault');
});

test('non-LinkedIn platform => skipped, never posts', async () => {
  const { db } = fakeDb();
  const li = fakeLinkedInFetch();
  const out = await publishItem({ db, item: VERA_PASS_ITEM({ platform: 'x' }), runId: 'r-8', now: VALID_NOW,
    deps: baseDeps({ live: true, fetch: li.fetchImpl }) });
  assert.equal(out.status, 'skipped');
  assert.equal(li.calls.posts.length, 0);
});

test('publish_due sweep: dry-runs each due item, never posts with flag off', async () => {
  const items = [VERA_PASS_ITEM({ id: 'q-10' }), VERA_PASS_ITEM({ id: 'q-11' })];
  const { db } = fakeDb({ listDue: async () => items });
  const li = fakeLinkedInFetch();
  const out = await publishDue({ db, runId: 'r-9', now: VALID_NOW, deps: baseDeps({ fetch: li.fetchImpl }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.swept, 2);
  assert.equal(li.calls.posts.length, 0, 'sweep is dry-run by default');
  assert.ok(out.results.every((r) => r.status === 'ok'));
});

test('refresh_tokens: refreshes a nearing-expiry token and writes it back', async () => {
  const { db } = fakeDb();
  const li = fakeLinkedInFetch();
  let put = null;
  const out = await refreshTokens({ db, runId: 'r-10',
    deps: { persons: ['ashton-couture'], getSecret: async () => EXPIRED_TOKEN_ENVELOPE, fetch: li.fetchImpl,
      putSecret: async (arn, val) => { put = JSON.parse(val); } } });
  assert.equal(out.status, 'ok');
  assert.equal(out.results[0].action, 'refreshed');
  assert.equal(li.calls.oauth.length, 1);
  assert.ok(put && put.access_token === 'NEW-ACCESS-TOKEN');
});
