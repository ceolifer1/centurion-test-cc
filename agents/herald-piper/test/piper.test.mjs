// Piper run-flow: kill-check first, session inject, login probe (fail-invalid,
// never relogin), reserve-then-act caps, and DRY-RUN publish that reaches
// NOWHERE real. All boundaries (session secret, browser, caps DB, Vera callback)
// are mocked - node --test, zero installed deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnce } from '../src/run.mjs';
import { fakeDb, fakeBrowser, APPROVED_ITEM, SESSION_ENVELOPE, VALID_NOW } from './fixtures.mjs';

const baseDeps = (over = {}) => ({
  getSecret: async () => SESSION_ENVELOPE,
  probe: async () => ({ loggedIn: true }),
  confirmPosted: async () => ({ status: 'ok' }),
  checkKill: async () => ({ ok: true, action: 'run' }),
  ...over,
});

test('happy path: DRY-RUN publish reaches nowhere real, marks posted, commits caps, calls Vera', async () => {
  const { db, calls } = fakeDb();
  const br = fakeBrowser();
  let livePostCalled = false;
  let confirmed = null;
  const out = await runOnce({
    db, item: APPROVED_ITEM(), runId: 'r-1', now: VALID_NOW,
    deps: baseDeps({ launchBrowser: br.launch, livePost: () => { livePostCalled = true; }, confirmPosted: async (a) => { confirmed = a; return { status: 'ok' }; } }),
  });
  assert.equal(out.status, 'ok');
  assert.equal(out.dryRun, true);
  assert.equal(livePostCalled, false); // NEVER touches a real profile
  // external_ref proves the dry-run surface, not a live post URL
  assert.match(out.externalRef, /^dryrun:/);
  const posted = calls.queuePatches.find((p) => p.status === 'posted');
  assert.ok(posted, 'queue item marked posted');
  assert.match(posted.external_ref, /^dryrun:/);
  assert.ok(calls.commits.length === 1, 'caps reservation committed');
  assert.ok(calls.events.some((e) => e.event_type === 'content.posted' && e.payload.dry_run === true));
  assert.ok(br.calls.addCookies && br.calls.addCookies.length === 2, 'session cookies injected into the context');
  assert.equal(br.calls.closed, true, 'browser closed on exit');
  assert.equal(confirmed.contentId, 'q-1'); // Vera confirm_posted callback fired
});

test('expired session (probe logged-out) -> INVALID, NO relogin, NO publish', async () => {
  const { db, calls } = fakeDb();
  const br = fakeBrowser();
  let published = false;
  const out = await runOnce({
    db, item: APPROVED_ITEM(), runId: 'r-2', now: VALID_NOW,
    deps: baseDeps({ launchBrowser: br.launch, probe: async () => ({ loggedIn: false }),
      publish: async () => { published = true; return {}; } }),
  });
  assert.equal(out.status, 'session_invalid');
  assert.equal(out.reloginAttempted, false);
  assert.equal(published, false);
  assert.ok(calls.events.some((e) => e.event_type === 'session.invalid'));
  // never marked posted
  assert.equal(calls.queuePatches.some((p) => p.status === 'posted'), false);
});

test('no session secret (revoked/expired) -> session_invalid before the browser even launches', async () => {
  const { db, calls } = fakeDb();
  let launched = false;
  const out = await runOnce({
    db, item: APPROVED_ITEM(), runId: 'r-3', now: VALID_NOW,
    deps: baseDeps({ getSecret: async () => { const e = new Error('gone'); e.notFound = true; throw e; },
      launchBrowser: async () => { launched = true; return {}; } }),
  });
  assert.equal(out.status, 'session_invalid');
  assert.equal(out.reason, 'no_secret');
  assert.equal(launched, false);
  assert.ok(calls.events.some((e) => e.event_type === 'session.invalid'));
});

test('kill switch engaged -> killed before any session fetch or publish', async () => {
  const { db, calls } = fakeDb();
  let secretFetched = false;
  const out = await runOnce({
    db, item: APPROVED_ITEM(), runId: 'r-4', now: VALID_NOW,
    deps: baseDeps({ checkKill: async () => ({ ok: false, action: 'kill', reason: 'kill' }),
      getSecret: async () => { secretFetched = true; return SESSION_ENVELOPE; } }),
  });
  assert.equal(out.status, 'killed');
  assert.equal(secretFetched, false);
  assert.ok(calls.events.some((e) => e.event_type === 'kill_switch.engaged'));
});

test('caps hard-stop aborts the WHOLE run (no publish, no throttle)', async () => {
  const { db, calls } = fakeDb({ reserveAction: async () => ({ allowed: false, reason: 'cap', window: 'day' }) });
  const br = fakeBrowser();
  let published = false;
  const out = await runOnce({
    db, item: APPROVED_ITEM(), runId: 'r-5', now: VALID_NOW,
    deps: baseDeps({ launchBrowser: br.launch, publish: async () => { published = true; return {}; } }),
  });
  assert.equal(out.status, 'caps_stop');
  assert.equal(out.reason, 'cap');
  assert.equal(published, false);
  assert.ok(calls.events.some((e) => e.event_type === 'caps.stop' && e.payload.hard_stop === true));
  assert.equal(calls.queuePatches.some((p) => p.status === 'posted'), false);
});

test('a non-publishable item (draft/vera_pass) is skipped, never published', async () => {
  const { db, calls } = fakeDb();
  const out = await runOnce({
    db, item: APPROVED_ITEM({ status: 'vera_pass' }), runId: 'r-6', now: VALID_NOW, deps: baseDeps(),
  });
  assert.equal(out.status, 'skipped');
  assert.equal(calls.queuePatches.length, 0);
});

test('publish failure -> caps rollback + item bounced + publish_failed event', async () => {
  const { db, calls } = fakeDb();
  const br = fakeBrowser();
  const out = await runOnce({
    db, item: APPROVED_ITEM(), runId: 'r-7', now: VALID_NOW,
    deps: baseDeps({ launchBrowser: br.launch, publish: async () => { throw new Error('platform 500'); } }),
  });
  assert.equal(out.status, 'error');
  assert.equal(calls.rollbacks.length, 1);
  assert.ok(calls.queuePatches.some((p) => p.status === 'bounced'));
  assert.ok(calls.events.some((e) => e.event_type === 'content.publish_failed'));
});
