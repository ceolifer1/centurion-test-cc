// herald-rhea contract + reporting tests. leadcrm read + notify + CF-prod db are
// all mocked - node --test, zero deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, MANIFEST } from '../src/index.mjs';
import { sumOptionA, displayBand } from '../src/leadcrm.mjs';
import { aggregate } from '../src/aggregate.mjs';
import { fakeDb, fakePipeline, DEALS } from './fixtures.mjs';

const NOW = '2026-07-13T12:00:00Z';
const make = (db, taskDeps, extra = {}) => createHandler({
  makeDb: async () => db, now: () => NOW, taskDeps,
  authorize: async () => ({ type: 'user', userId: 'ceo', email: 'ceo@centurionfinancial.com', role: 'company_admin' }),
  ...extra,
});
const env = (task, payload = {}, extra = {}) => ({
  runId: '11111111-1111-4111-8111-111111111111', mode: 'task', task,
  actor: { userId: 'ceo' }, __userToken: 'ceo-jwt', payload, trace: { chain: [] }, ...extra,
});

test('GET /manifest returns the AGT-2 shape (rhea, weekly+monthly, deterministic)', async () => {
  const { db } = fakeDb();
  const res = await make(db, {})({ requestContext: { http: { method: 'GET' } }, rawPath: '/manifest' });
  assert.equal(res.statusCode, 200);
  const m = JSON.parse(res.body);
  assert.equal(m.service, 'herald-rhea');
  assert.deepEqual(m.capabilities, ['weekly_report', 'monthly_report']);
  assert.equal(m.deterministic_only, true);
  assert.equal(MANIFEST.engine, 'herald');
});

test('SPEC-F Option A: sumOptionA counts Enterprise lending + Funding amount, excludes won/lost/other pipelines', () => {
  const { value, deal_count } = sumOptionA(DEALS);
  // 4_148_000_000 (Ent lending) + 40_000_000 (Ent lending) + 28_500_000 (Funding amount) = 4_216_500_000
  assert.equal(value, 4216500000);
  assert.equal(deal_count, 3);
});

test('displayBand rounds DOWN to a defensible band ($4.75B -> $4.7B+)', () => {
  assert.equal(displayBand(4750000000), '$4.7B+');
  assert.equal(displayBand(376000000), '$376M+');
  assert.equal(displayBand(0), '$0');
});

test('weekly_report assembles the correct Option A figure, calls notify, writes herald_reports', async () => {
  const { db, calls } = fakeDb();
  const sent = [];
  const res = await make(db, { readPipelineValue: fakePipeline(), sendNotify: async (a) => { sent.push(a); return { ok: true }; } })(env('weekly_report'));
  assert.equal(res.status, 'ok');
  // Report stored with the branded HTML + metrics.
  assert.equal(calls.reportUpserts.length, 1);
  const stored = calls.reportUpserts[0];
  assert.equal(stored.type, 'weekly');
  assert.match(stored.body_html, /HERALD Weekly Presence Report/);
  assert.equal(stored.metrics.pipeline.display, '$4.7B+');
  assert.equal(stored.metrics.pipeline.value, 4750000000);
  assert.match(stored.metrics.pipeline.framing, /current active pipeline/);
  // The mandatory follows line.
  assert.equal(stored.metrics.follows.line, 'X follows: 2 queued for your tap — automated follows disabled');
  assert.match(stored.body_html, /queued for your tap/);
  // Notify called with the report to ceo@.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'report');
  assert.deepEqual(sent[0].to, ['ceo@centurionfinancial.com']);
  assert.match(sent[0].subject, /Weekly Presence Report/);
  assert.ok(sent[0].html.length > 500);
  // Events: composed + sent + notify.sent, and the report marked sent.
  assert.ok(calls.events.some((e) => e.event_type === 'report.composed'));
  assert.ok(calls.events.some((e) => e.event_type === 'report.sent'));
  assert.equal(calls.reportSent.length, 1);
  assert.deepEqual(calls.reportSent[0].to, ['ceo@centurionfinancial.com']);
});

test('weekly_report shows posted/engagement/coverage and the deltas vs prior report', async () => {
  const { db, calls } = fakeDb();
  await make(db, { readPipelineValue: fakePipeline(), sendNotify: async () => ({ ok: true }) })(env('weekly_report'));
  const m = calls.reportUpserts[0].metrics;
  assert.equal(m.posted.count, 2);
  assert.equal(m.engagement.reach, 2000); // 1200 + 800
  assert.equal(m.followers.net_new, 12);
  assert.equal(m.coverage.roster_score, 14.3);
  assert.equal(m.coverage.delta, 2.3); // 14.3 - 12.0
  assert.equal(m.bounces.count, 1);
  assert.equal(m.caps.warnings, 1);
});

test('monthly_report uses type=monthly over a 30-day window', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db, { readPipelineValue: fakePipeline(), sendNotify: async () => ({ ok: true }) })(env('monthly_report'));
  assert.equal(res.status, 'ok');
  assert.equal(calls.reportUpserts[0].type, 'monthly');
  assert.match(calls.reportUpserts[0].body_html, /Monthly Presence Report/);
});

test('notify failure -> report stored (sent_at null), report.send_failed, task still ok', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db, { readPipelineValue: fakePipeline(), sendNotify: async () => { throw new Error('provider 500'); } })(env('weekly_report'));
  assert.equal(res.status, 'ok');
  assert.equal(calls.reportUpserts.length, 1); // still stored
  assert.equal(calls.reportSent.length, 0);    // never marked sent
  assert.ok(calls.events.some((e) => e.event_type === 'report.send_failed'));
});

test('pipeline read failure degrades the headline but still composes + sends', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db, { readPipelineValue: async () => { throw new Error('leadcrm down'); }, sendNotify: async () => ({ ok: true }) })(env('weekly_report'));
  assert.equal(res.status, 'ok');
  assert.equal(calls.reportUpserts[0].metrics.pipeline, null);
  assert.match(calls.reportUpserts[0].metrics.pipeline_error, /leadcrm down/);
  assert.ok(calls.events.some((e) => e.event_type === 'report.sent'));
});

test('aggregate is a pure function of its inputs (follows line always present)', () => {
  const m = aggregate({ type: 'weekly', periodStart: '2026-07-06', periodEnd: '2026-07-13', queueRows: [], events: [], followSuggestions: 5 });
  assert.equal(m.follows.line, 'X follows: 5 queued for your tap — automated follows disabled');
  assert.equal(m.follows.automated_disabled, true);
});

test('scheduled mode (Monday 07:00a CT cron) is accepted as a system actor', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db, { readPipelineValue: fakePipeline(), sendNotify: async () => ({ ok: true }) })(env('weekly_report', {}, { mode: 'scheduled', __userToken: undefined }));
  assert.equal(res.status, 'ok');
  assert.equal(calls.runs[0].actor_user_id, 'system:scheduler');
});

test('kill switch engaged -> killed before any report is composed or sent', async () => {
  const { db, calls } = fakeDb({ readControls: async () => [{ scope: 'global', state: 'kill' }] });
  const sent = [];
  const res = await make(db, { readPipelineValue: fakePipeline(), sendNotify: async (a) => { sent.push(a); } })(env('weekly_report'));
  assert.equal(res.status, 'killed');
  assert.equal(calls.reportUpserts.length, 0);
  assert.equal(sent.length, 0);
  assert.ok(calls.events.some((e) => e.event_type === 'kill_switch.engaged'));
});

test('controls unreachable -> fail closed (refused), never composes', async () => {
  const { db, calls } = fakeDb({ readControls: async () => { throw new Error('down'); } });
  const res = await make(db, { readPipelineValue: fakePipeline(), sendNotify: async () => ({}) })(env('weekly_report'));
  assert.equal(res.status, 'refused');
  assert.match(res.reply, /controls_unreachable/);
  assert.equal(calls.reportUpserts.length, 0);
});

test('peer call from an unknown caller is refused (ALLOWED_CALLERS empty at P1)', async () => {
  const { db } = fakeDb();
  const res = await make(db, {})(env('weekly_report', {}, { trace: { chain: ['mallory'] }, __userToken: undefined }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.status, 'refused');
});

test('unknown task and bad mode are 400s', async () => {
  const { db } = fakeDb();
  assert.equal((await make(db, {})(env('do_crimes'))).statusCode, 400);
  assert.equal((await make(db, {})(env('weekly_report', {}, { mode: 'yolo' }))).statusCode, 400);
});
