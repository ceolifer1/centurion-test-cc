// herald-cass contract + planner tests. External boundaries (CF-prod db, the
// Anthropic ideation model) are mocked - node --test, zero deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, MANIFEST } from '../src/index.mjs';
import { buildCalendar, validateCalendar } from '../src/planner.mjs';
import { activeHours } from '../src/caps.mjs';
import { fakeDb, fakeIdeation } from './fixtures.mjs';

const NOW = '2026-07-13T00:00:00Z'; // a Monday
// Dashboard calls carry a Supabase JWT; the handler verifies it via authorize().
// Stub authorize to a capability-holding user so task paths are exercised.
const make = (db, taskDeps, extra = {}) => createHandler({
  makeDb: async () => db, now: () => NOW, taskDeps,
  authorize: async () => ({ type: 'user', userId: 'ceo', email: 'ceo@centurionfinancial.com', role: 'company_admin' }),
  ...extra,
});

const calEnvelope = (payload, extra = {}) => ({
  runId: '11111111-1111-4111-8111-111111111111', mode: 'task', task: 'build_calendar',
  actor: { userId: 'ceo' }, __userToken: 'ceo-jwt',
  payload: { person: 'ashton-couture', period: { start: NOW, weeks: 4 }, themes: ['market structure', 'capital formation'], ...payload },
  trace: { chain: [] }, ...extra,
});

test('GET /manifest returns the AGT-2 shape (cass, two capabilities)', async () => {
  const { db } = fakeDb();
  const res = await make(db, {})({ requestContext: { http: { method: 'GET' } }, rawPath: '/manifest' });
  assert.equal(res.statusCode, 200);
  const m = JSON.parse(res.body);
  assert.equal(m.service, 'herald-cass');
  assert.deepEqual(m.capabilities, ['build_calendar', 'suggest_campaign']);
  assert.equal(m.variant, 'lambda');
  assert.equal(MANIFEST.engine, 'herald');
});

test('planner: every slot is inside active hours and no cap is exceeded (8-week, 2 platforms)', () => {
  const { slots } = buildCalendar({
    person: 'ashton-couture', platforms: ['linkedin_personal', 'x'],
    startIso: '2026-07-13T00:00:00Z', endIso: '2026-09-07T00:00:00Z',
    themes: ['a', 'b', 'c'], targetRatio: 0.6, tier: 'run', seed: 's1',
  });
  assert.ok(slots.length > 0, 'planner produced slots');
  // Independent re-check of the P0 invariants (active hours + every cap).
  const check = validateCalendar(slots);
  assert.ok(check.ok, check.reason);
  // Every slot passes the CT active-hours gate.
  for (const s of slots) assert.ok(activeHours(new Date(s.scheduled_for), 'post').allowed, `slot ${s.scheduled_for} out of hours`);
});

test('planner is deterministic for a fixed seed', () => {
  const args = { person: 'ashton-couture', platforms: ['linkedin_personal'], startIso: '2026-07-13T00:00:00Z', endIso: '2026-08-10T00:00:00Z', themes: ['x'], seed: 'fixed' };
  const a = buildCalendar(args); const b = buildCalendar(args);
  assert.deepEqual(a.slots, b.slots);
});

test('build_calendar writes a herald_schedules row + calendar.built event, run tier', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db, {})(calEnvelope());
  assert.equal(res.status, 'ok');
  assert.equal(calls.scheduleInserts.length, 1);
  const sch = calls.scheduleInserts[0];
  assert.equal(sch.agent, 'cass');
  assert.equal(sch.enabled, false);
  assert.equal(sch.created_by, 'cass');
  assert.equal(sch.payload.tier, 'run'); // ashton is run tier
  assert.ok(sch.payload.slots.length > 0);
  // The stored plan passes the cap/active-hours check independently.
  assert.ok(validateCalendar(sch.payload.slots).ok);
  assert.ok(calls.events.some((e) => e.event_type === 'calendar.built'));
  // artifact carries the slots for the dashboard preview.
  assert.equal(res.artifacts[0].type, 'content_calendar');
});

test('crawl-tier person is stamped tier=crawl on the plan', async () => {
  const { db, calls } = fakeDb({ getFactFile: async () => ({ data: { person_id: 'stephen-warren', platforms: ['linkedin_personal'] } }) });
  await make(db, {})(calEnvelope({ person: 'stephen-warren' }));
  assert.equal(calls.scheduleInserts[0].payload.tier, 'crawl');
  assert.ok(calls.scheduleInserts[0].payload.slots.every((s) => s.tier === 'crawl'));
});

test('scheduled mode (EventBridge, no bearer) is accepted as a system actor', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db, {})(calEnvelope({}, { mode: 'scheduled', __userToken: undefined }));
  assert.equal(res.status, 'ok');
  assert.equal(calls.runs[0].actor_user_id, 'system:scheduler');
});

test('ideate=true with no themes calls the model, ledgers the cost', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db, { callModel: fakeIdeation() })(calEnvelope({ themes: undefined, ideate: true }));
  assert.equal(res.status, 'ok');
  assert.ok(res.usage.costUsd > 0);
  assert.ok(calls.events.some((e) => e.event_type === 'model_call'));
  // The ideated themes flow into the plan.
  assert.ok(calls.scheduleInserts[0].payload.themes.includes('capital formation'));
});

test('engine budget exhausted on ideate -> budget_exhausted, no plan written', async () => {
  const { db, calls } = fakeDb({ monthSpendCents: async () => 40000 });
  let modelCalled = false;
  const res = await make(db, { callModel: async () => { modelCalled = true; return {}; } })(calEnvelope({ themes: undefined, ideate: true }));
  assert.equal(res.status, 'budget_exhausted');
  assert.equal(res.statusCode, 402);
  assert.equal(modelCalled, false);
  assert.equal(calls.scheduleInserts.length, 0);
  assert.ok(calls.events.some((e) => e.event_type === 'budget_stop'));
});

test('kill switch engaged -> killed before any planning', async () => {
  const { db, calls } = fakeDb({ readControls: async () => [{ scope: 'global', state: 'kill' }] });
  const res = await make(db, {})(calEnvelope());
  assert.equal(res.status, 'killed');
  assert.equal(calls.scheduleInserts.length, 0);
  assert.ok(calls.events.some((e) => e.event_type === 'kill_switch.engaged'));
});

test('controls unreachable -> fail closed (refused), never plans', async () => {
  const { db, calls } = fakeDb({ readControls: async () => { throw new Error('supabase down'); } });
  const res = await make(db, {})(calEnvelope());
  assert.equal(res.status, 'refused');
  assert.match(res.reply, /controls_unreachable/);
  assert.equal(calls.scheduleInserts.length, 0);
});

test('peer call from an unknown caller is refused (ALLOWED_CALLERS empty at P1)', async () => {
  const { db } = fakeDb();
  const res = await make(db, {})(calEnvelope({}, { mode: 'task', trace: { chain: ['mallory'] }, __userToken: undefined }));
  assert.equal(res.statusCode, 401);
  assert.equal(res.status, 'refused');
});

test('suggest_campaign returns a phased campaign + cap-safe preview', async () => {
  const { db, calls } = fakeDb();
  const res = await make(db, {})({
    runId: '22222222-2222-4222-8222-222222222222', mode: 'task', task: 'suggest_campaign',
    actor: { userId: 'ceo' }, __userToken: 'ceo-jwt', payload: { person: 'ashton-couture', goal: 'Grow presence', weeks: 6 }, trace: { chain: [] },
  });
  assert.equal(res.status, 'ok');
  const camp = res.artifacts[0].data;
  assert.equal(camp.phases.length, 3);
  assert.ok(validateCalendar(camp.calendar_preview).ok);
  assert.ok(calls.events.some((e) => e.event_type === 'campaign.suggested'));
});

test('unknown task and bad mode are 400s', async () => {
  const { db } = fakeDb();
  assert.equal((await make(db, {})(calEnvelope({}, { task: 'do_crimes' }))).statusCode, 400);
  assert.equal((await make(db, {})(calEnvelope({}, { mode: 'yolo' }))).statusCode, 400);
});
