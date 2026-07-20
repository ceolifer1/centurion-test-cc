// Piper DRY-RUN proof harness (P1 Build Plan section 4 / SPEC-C 9). Runs Piper's
// REAL run.mjs (runOnce) end-to-end against a MOCK surface - no real account, no
// real session, no browser, nothing published anywhere real. It exercises the
// full container publish flow: kill-check -> session inject (mock) -> login probe
// (mock) -> caps reserve (reserve-then-act) -> DRY-RUN publish ("would-post"
// recording) -> mark posted -> Vera confirm, and prints the evidence trail
// (herald_events, queue patch, caps calls) a real Fargate RunTask would produce.
import { runOnce } from '../src/run.mjs';

process.env.CF_SERVICE_KEY = process.env.CF_SERVICE_KEY || 'dryrun-key';
delete process.env.HERALD_LIVE; // dry-run default

// A capturing in-memory db (the exact interface run.mjs uses). Records every
// write so we can print the audit trail. reserve-then-act is honored: reserve
// returns allowed, commit records the slot.
function captureDb() {
  const calls = { events: [], queuePatches: [], runPatches: [], reserves: [], commits: [] };
  const db = {
    readControls: async () => [{ scope: 'global', state: 'run' }],
    insertEvent: async (r) => { calls.events.push(r); },
    insertRun: async () => {},
    patchRun: async (id, r) => { calls.runPatches.push({ id, ...r }); },
    getQueueItem: async () => null,
    patchQueueItem: async (id, r) => { calls.queuePatches.push({ id, ...r }); },
    reserveAction: async (...a) => { calls.reserves.push(a); return { allowed: true }; },
    commitAction: async (...a) => { calls.commits.push(a); },
    rollbackAction: async () => {},
    lastActionAt: async () => null,
  };
  return { db, calls };
}

const SESSION = JSON.stringify({
  cookies: [{ name: 'li_at', value: 'MOCK-NEVER-REAL', domain: '.linkedin.com', path: '/' }],
  userAgent: 'Mozilla/5.0 (mock fingerprint)', viewport: { width: 1280, height: 800 },
  capturedAt: '2026-07-20T00:00:00Z', consentRowId: 'mock-consent', platform: 'linkedin_personal',
});

const ITEM = { id: 'dryrun-item-1', person: 'ashton-couture', platform: 'linkedin_personal',
  kind: 'post', status: 'approved', tier: 'run', body: 'A quiet, factual institutional update (DRY-RUN, nowhere real).' };

const fakeBrowser = () => {
  const state = { closed: false, cookies: null };
  const context = { addCookies: async (c) => { state.cookies = c; }, newPage: async () => ({ goto: async () => {}, evaluate: async () => true, close: async () => {} }) };
  return { launch: async () => ({ browser: { close: async () => { state.closed = true; } }, context }), state };
};

const { db, calls } = captureDb();
const br = fakeBrowser();
let livePostCalled = false;
let veraConfirm = null;

// Monday 2026-07-13 10:00 CT — inside SPEC-D active hours for a post.
const out = await runOnce({
  db, item: ITEM, runId: 'dryrun-run-1', now: () => new Date('2026-07-13T15:00:00Z'),
  deps: {
    getSecret: async () => SESSION,                         // mock vaulted session (no real cookies)
    launchBrowser: br.launch,                               // fake browser (no Chromium)
    probe: async () => ({ loggedIn: true }),                // mock login-state probe
    publish: undefined,                                     // use the REAL dry-run publisher
    livePost: () => { livePostCalled = true; },             // must NEVER be called
    confirmPosted: async (a) => { veraConfirm = a; return { status: 'ok' }; },
    checkKill: async () => ({ ok: true, action: 'run' }),
  },
});

console.log('=== PIPER DRY-RUN RESULT ===');
console.log('status            :', out.status);
console.log('dryRun            :', out.dryRun);
console.log('externalRef       :', out.externalRef);
console.log('livePost called?  :', livePostCalled, '(MUST be false — nowhere real)');
console.log('session injected  :', br.state.cookies ? `${br.state.cookies.length} cookie(s) into in-memory context` : 'none');
console.log('browser closed?   :', br.state.closed);
console.log('caps reserved     :', calls.reserves.length, '| committed:', calls.commits.length);
console.log('queue patch       :', JSON.stringify(calls.queuePatches.find((p) => p.status === 'posted') || null));
console.log('vera confirm sent :', veraConfirm ? `contentId=${veraConfirm.contentId} url=${veraConfirm.postUrl}` : 'none');
console.log('herald_events     :');
for (const e of calls.events) console.log('   -', e.event_type, JSON.stringify(e.payload));

const ok = out.status === 'ok' && out.dryRun === true && /^dryrun:/.test(out.externalRef || '') &&
  livePostCalled === false && calls.reserves.length === 1 && calls.commits.length === 1 &&
  calls.queuePatches.some((p) => p.status === 'posted' && /^dryrun:/.test(p.external_ref || '')) &&
  calls.events.some((e) => e.event_type === 'content.posted' && e.payload.dry_run === true);
console.log('\n=== VERDICT:', ok ? 'PASS — dry-run publish flow proven, nothing real touched' : 'FAIL', '===');
process.exit(ok ? 0 : 1);
