// SPEC-D caps: reserve-then-act with HARD-STOP semantics. At cap => hard stop,
// not throttle. Disabled action (X auto-follow) => hard stop. Out of active
// hours / spacing violation => hard stop. Reservation increments BEFORE the act.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as caps from '../src/caps.mjs';
import { fakeDb, VALID_NOW } from './fixtures.mjs';

const SUN_NOW = () => new Date('2026-07-12T15:00:00Z'); // Sunday 10:00 CT

test('at-cap -> hard stop (not throttle), and the reservation was attempted', async () => {
  const { db, calls } = fakeDb({ reserveAction: async (...a) => { calls.reserves.push(a); return { allowed: false, reason: 'cap', window: 'day' }; } });
  const r = await caps.reserve(db, { person: 'ashton-couture', platform: 'linkedin_personal', actionClass: 'post', now: VALID_NOW() });
  assert.equal(r.allowed, false);
  assert.equal(r.hardStop, true);
  assert.equal(r.reason, 'cap');
  assert.equal(calls.reserves.length, 1); // reserve-then-act: the DB check ran
});

test('under cap -> allowed, windows returned for commit/rollback', async () => {
  const { db } = fakeDb();
  const r = await caps.reserve(db, { person: 'ashton-couture', platform: 'linkedin_personal', actionClass: 'post', now: VALID_NOW() });
  assert.equal(r.allowed, true);
  assert.ok(Array.isArray(r.windows) && r.windows.length >= 2); // day + week + burst
  assert.ok(r.windows.some((w) => w.type === 'burst'));
});

test('X auto-follow is DISABLED at P0 -> hard stop before any DB reservation', async () => {
  const { db, calls } = fakeDb();
  const r = await caps.reserve(db, { person: 'ashton-couture', platform: 'x', actionClass: 'follow', now: VALID_NOW() });
  assert.equal(r.hardStop, true);
  assert.equal(r.reason, 'disabled');
  assert.equal(calls.reserves.length, 0); // never even asked the counter
});

test('unmapped action class -> hard stop (no cap = no action, conservative)', async () => {
  const { db } = fakeDb();
  const r = await caps.reserve(db, { person: 'ashton-couture', platform: 'x', actionClass: 'mystery', now: VALID_NOW() });
  assert.equal(r.hardStop, true);
  assert.equal(r.reason, 'no_cap');
});

test('Sunday -> hard stop (active-hours: nothing on Sunday)', async () => {
  const { db, calls } = fakeDb();
  const r = await caps.reserve(db, { person: 'ashton-couture', platform: 'linkedin_personal', actionClass: 'post', now: SUN_NOW() });
  assert.equal(r.hardStop, true);
  assert.match(r.reason, /active_hours/);
  assert.equal(calls.reserves.length, 0);
});

test('spacing: an action within min_spacing of the last one -> hard stop', async () => {
  const last = new Date(VALID_NOW().getTime() - 60 * 1000).toISOString(); // 60s ago (< 180s)
  const { db } = fakeDb({ lastActionAt: async () => last });
  const r = await caps.reserve(db, { person: 'ashton-couture', platform: 'linkedin_personal', actionClass: 'post', now: VALID_NOW() });
  assert.equal(r.hardStop, true);
  assert.equal(r.reason, 'spacing');
});

test('caps.json is the config-as-code source (SPEC-D 7.4), version tagged', () => {
  assert.match(caps.CAPS_VERSION, /spec-d/);
});
