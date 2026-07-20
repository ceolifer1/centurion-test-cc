// SPEC-D platform-safety enforcement - reserve-then-act with hard-stop semantics.
// Exact peer of agents/herald-piper/src/caps.mjs (Gia and Piper enforce the same
// caps.json). Gia obtains a reservation PER ACTION before it clears an engagement;
// the counter increments (reserved++) BEFORE the action via the herald_rate_reserve
// RPC, so a crash can never undercount (SPEC-D 7.1). A would-exceed on ANY window,
// an out-of-active-hours action, a spacing violation, or a disabled action returns
// { hardStop:true } - and the caller aborts the WHOLE run for that (person,
// platform). No throttling, no carry-over, no resume (SPEC-D section 1).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CAPS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'caps.json'), 'utf8'));
export const CAPS_VERSION = CAPS.version;

// --- America/Chicago calendar helpers (SPEC-D windows are all CT) -------------
function ctParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: CAPS.global.active_hours.timezone, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  let hour = parseInt(p.hour, 10); if (hour === 24) hour = 0;
  return { weekday: p.weekday, y: +p.year, m: +p.month, d: +p.day, hour, minute: +p.minute };
}
function isoWeekKey(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
const hhmmToMin = (s) => { const [h, mn] = s.split(':').map(Number); return h * 60 + mn; };

// --- active-hours gate (SPEC-D section 1) -------------------------------------
export function activeHours(date, actionClass) {
  const ct = ctParts(date);
  const ah = CAPS.global.active_hours;
  const mins = ct.hour * 60 + ct.minute;
  if (ct.weekday === 'Sun') return { allowed: false, reason: 'active_hours:sunday' };
  if (ct.weekday === 'Sat') {
    if (ah.saturday.posts_only && actionClass !== 'post') return { allowed: false, reason: 'active_hours:sat_posts_only' };
    if (mins < hhmmToMin(ah.saturday.start) || mins > hhmmToMin(ah.saturday.end)) return { allowed: false, reason: 'active_hours:sat_window' };
    return { allowed: true };
  }
  if (mins < hhmmToMin(ah.weekday.start) || mins > hhmmToMin(ah.weekday.end)) return { allowed: false, reason: 'active_hours:weekday_window' };
  return { allowed: true };
}

// Build the day/week/burst windows (with caps) for a (platform, actionClass).
export function windowsFor(platform, actionClass, date) {
  const capDef = CAPS.platforms?.[platform]?.[actionClass];
  if (!capDef) return { capDef: null, windows: [] };
  const ct = ctParts(date);
  const dayKey = `${ct.y}-${String(ct.m).padStart(2, '0')}-${String(ct.d).padStart(2, '0')}`;
  const bucket = Math.floor(ct.minute / CAPS.global.burst.window_minutes) * CAPS.global.burst.window_minutes;
  const windows = [];
  if (capDef.day != null) windows.push({ type: 'day', key: dayKey, cap: capDef.day });
  if (capDef.week != null) windows.push({ type: 'week', key: isoWeekKey(ct.y, ct.m, ct.d), cap: capDef.week });
  windows.push({ type: 'burst', key: `${dayKey}T${String(ct.hour).padStart(2, '0')}:${String(bucket).padStart(2, '0')}`, cap: CAPS.global.burst.max });
  return { capDef, windows };
}

// The reservation. Returns { allowed:true, windows } OR { allowed:false,
// hardStop:true, reason }. reserve-then-act: the DB RPC atomically checks all
// windows and increments `reserved` (never after the fact).
export async function reserve(db, { person, platform, actionClass, now = new Date() }) {
  const { capDef, windows } = windowsFor(platform, actionClass, now);
  if (!capDef) return { allowed: false, hardStop: true, reason: 'no_cap' };
  if (capDef.disabled || capDef.day === 0) return { allowed: false, hardStop: true, reason: 'disabled' };

  const ah = activeHours(now, actionClass);
  if (!ah.allowed) return { allowed: false, hardStop: true, reason: ah.reason };

  // Spacing: >= min_spacing_seconds since the last committed action (SPEC-D 1).
  const last = await db.lastActionAt(person, platform);
  if (last) {
    const gap = (now.getTime() - new Date(last).getTime()) / 1000;
    if (gap < CAPS.global.min_spacing_seconds) return { allowed: false, hardStop: true, reason: 'spacing' };
  }

  const r = await db.reserveAction(person, platform, actionClass, windows);
  if (!r || r.allowed !== true) {
    return { allowed: false, hardStop: true, reason: r?.reason || 'cap', window: r?.window || null };
  }
  return { allowed: true, windows };
}

export const commit = (db, person, platform, actionClass, windows) => db.commitAction(person, platform, actionClass, windows);
export const rollback = (db, person, platform, actionClass, windows) => db.rollbackAction(person, platform, actionClass, windows);
