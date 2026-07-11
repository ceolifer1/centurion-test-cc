// Deterministic content-calendar planner. Given a person, a period, a platform
// set, and a theme list, it lays out 'post' slots that (1) fall inside SPEC-D
// active hours, (2) never exceed any SPEC-D day/week/burst cap, and (3) sit at
// the target utilisation band (50-70% of caps, SPEC-D section 0). Fully
// deterministic for a given seed so the same request replans identically and
// tests are stable - the only non-determinism in HERALD scheduling is the
// act-time jitter Piper applies, never the plan.
import { activeHours, windowsFor, capDefFor, ctParts } from './caps.mjs';

// mulberry32 - tiny deterministic PRNG (no deps).
function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Interpret a CT wall-clock (y,m,d,hh,mm) as a UTC instant.
function ctToUtc(y, m, d, hh, mm) {
  const utcGuess = Date.UTC(y, m - 1, d, hh, mm);
  const ct = ctParts(new Date(utcGuess));
  const rendered = Date.UTC(ct.y, ct.m - 1, ct.d, ct.hour, ct.minute);
  return new Date(2 * utcGuess - rendered);
}

// The good posting hours inside the weekday window; Saturday uses the AM window.
const WEEKDAY_HOURS = [8, 12, 16];
const SAT_HOURS = [9, 10, 11];

function eligibleDaysInWeek(days) {
  // Mon-Sat are eligible (Sunday excluded by active hours). Returns the subset.
  return days.filter((d) => d.weekday !== 'Sun');
}

// Choose `n` day-indices spread across an array of length len (deterministic).
function spread(len, n) {
  if (n <= 0 || len <= 0) return [];
  if (n >= len) return Array.from({ length: len }, (_, i) => i);
  const out = [];
  const step = len / n;
  for (let i = 0; i < n; i++) out.push(Math.min(len - 1, Math.round(i * step + step / 2 - 0.5)));
  return [...new Set(out)];
}

// Build the list of CT calendar days between start and end (inclusive).
function daysBetween(startIso, endIso) {
  const start = new Date(startIso); const end = new Date(endIso);
  const out = [];
  // Walk noon-CT anchored to avoid DST edge slips.
  for (let t = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), 17, 0));
    t <= end; t = new Date(t.getTime() + 86400000)) {
    const ct = ctParts(t);
    out.push({ y: ct.y, m: ct.m, d: ct.d, weekday: ct.weekday, week: `${ct.y}-${ct.m}-${ct.d}` });
  }
  return out;
}

function isoWeekOf(day) {
  const dt = new Date(Date.UTC(day.y, day.m - 1, day.d));
  const dow = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dow);
  const ys = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((dt - ys) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

// The whole plan. Returns { slots, meta } where each slot is a fully-formed
// brief-carrying calendar entry with a UTC scheduled_for.
export function buildCalendar({
  person, platforms, startIso, endIso, themes, targetRatio = 0.6, tier = 'crawl', seed,
}) {
  const rand = rng(seed || `${person}|${startIso}|${endIso}|${(themes || []).join(',')}`);
  const themeList = (themes && themes.length) ? themes : ['institutional focus', 'market perspective', 'firm update'];
  const days = daysBetween(startIso, endIso);
  // Group days by ISO week.
  const weeks = new Map();
  for (const d of days) {
    const wk = isoWeekOf(d);
    if (!weeks.has(wk)) weeks.set(wk, []);
    weeks.get(wk).push(d);
  }

  // Tally keys must be the SAME composite the DB enforces: (platform,
  // action_class, window). A bare week-string collides across platforms (both
  // linkedin_personal and x share ISO week 2026-W29), which would let X posts
  // consume LinkedIn's cap. Namespace by platform|action|type|key.
  const tally = new Map();
  const tkey = (platform, action, w) => `${platform}|${action}|${w.type}|${w.key}`;
  const wouldExceed = (platform, action, windows) => windows.some((w) => (tally.get(tkey(platform, action, w)) || 0) + 1 > w.cap);
  const commit = (platform, action, windows) => windows.forEach((w) => { const k = tkey(platform, action, w); tally.set(k, (tally.get(k) || 0) + 1); });

  const slots = [];
  let themeIdx = 0;
  const perPlatformTarget = {};

  for (const platform of platforms) {
    const cap = capDefFor(platform, 'post');
    if (!cap || cap.disabled || cap.day === 0) continue;
    const weekCap = cap.week != null ? cap.week : (cap.day != null ? cap.day * 6 : 0);
    // Target sits in the SPEC-D band; at least 1/week if any capacity exists.
    const weekTarget = Math.max(1, Math.min(weekCap, Math.round(weekCap * targetRatio)));
    perPlatformTarget[platform] = { weekCap, weekTarget };

    for (const [, wdays] of weeks) {
      const eligible = eligibleDaysInWeek(wdays);
      const pickIdx = spread(eligible.length, Math.min(weekTarget, eligible.length));
      for (const di of pickIdx) {
        const day = eligible[di];
        const isSat = day.weekday === 'Sat';
        const hours = isSat ? SAT_HOURS : WEEKDAY_HOURS;
        const hour = hours[Math.floor(rand() * hours.length)];
        const minute = Math.floor(rand() * 23); // 0-22, mirrors jitter budget
        const when = ctToUtc(day.y, day.m, day.d, hour, minute);
        const ah = activeHours(when, 'post');
        if (!ah.allowed) continue; // never plan an out-of-window slot
        const { windows } = windowsFor(platform, 'post', when);
        if (wouldExceed(platform, 'post', windows)) continue; // never plan past a cap
        commit(platform, 'post', windows);
        const theme = themeList[themeIdx % themeList.length];
        themeIdx++;
        slots.push({
          person, platform, kind: 'post', tier,
          scheduled_for: when.toISOString(),
          theme,
          brief: `Theme: ${theme}. Draft a ${platform} post for ${person}, grounded strictly in the approved fact-file (no AUM/raised claims, non-promissory institutional voice).`,
          windows: windows.map((w) => `${w.type}:${w.key}`),
        });
      }
    }
  }

  slots.sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for));
  return { slots, meta: { perPlatformTarget, weeks: weeks.size, themeCount: themeList.length, targetRatio } };
}

// Validation used by tests + the task: assert no slot violates active hours or caps.
export function validateCalendar(slots) {
  const tally = new Map();
  for (const s of slots) {
    const when = new Date(s.scheduled_for);
    const ah = activeHours(when, s.kind === 'post' ? 'post' : s.kind);
    if (!ah.allowed) return { ok: false, reason: `slot out of active hours (${ah.reason})`, slot: s };
    const { windows } = windowsFor(s.platform, 'post', when);
    for (const w of windows) {
      const k = `${s.platform}|post|${w.type}|${w.key}`;
      const n = (tally.get(k) || 0) + 1;
      tally.set(k, n);
      if (n > w.cap) return { ok: false, reason: `cap exceeded on ${s.platform} ${w.type} ${w.key}`, slot: s };
    }
  }
  return { ok: true };
}
