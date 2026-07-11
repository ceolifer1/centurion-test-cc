// Cass's two capabilities: build_calendar (deterministic slot plan -> a
// herald_schedules calendar row + slot briefs Nico can expand) and
// suggest_campaign (a phased campaign shape for a goal). Scheduling is always
// deterministic and cap-safe; the model is used ONLY to ideate themes, and only
// when asked (SPEC-D: Cass plans volume, Vera enforces the ceilings).
import {
  RUN_PERSONS, DEFAULT_PLATFORMS, DEFAULT_TARGET_RATIO, ENGINE_BUDGET_CENTS, secrets,
} from './config.mjs';
import { buildCalendar, validateCalendar } from './planner.mjs';
import { CAPS_VERSION } from './caps.mjs';
import { pickModel, callModel, ideationPrompt, parseThemes } from './router.mjs';

const tierFor = (person) => (RUN_PERSONS.includes(person) ? 'run' : 'crawl');
const month = (now) => now.slice(0, 7);
const DAY_MS = 86400000;

function resolvePeriod(period = {}, now) {
  const start = period.start ? new Date(period.start) : new Date(now);
  const weeks = period.weeks != null ? Number(period.weeks) : null;
  let end;
  if (period.end) end = new Date(period.end);
  else end = new Date(start.getTime() + (weeks && weeks > 0 ? weeks : 4) * 7 * DAY_MS);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

// Optional theme ideation (model). Budget-gated + ledgered like Nico. Returns
// { themes, usage, costCents, model } or null (fallback to deterministic themes).
async function ideateThemes({ person, factFile, db, now, deps }) {
  let spent = 0;
  try { spent = await db.monthSpendCents(month(now)); } catch { spent = 0; }
  if (spent >= ENGINE_BUDGET_CENTS) return { budgetExhausted: true, spent };
  const model = pickModel({ brief: JSON.stringify(factFile || {}) });
  const key = (await secrets())['anthropic-key'];
  const call = deps.callModel || callModel;
  const out = await call({ model, system: ideationPrompt({ person, factFile }), user: 'Propose the themes now.', anthropicKey: key, maxTokens: 400, fetchImpl: deps.fetch });
  const themes = parseThemes(out.text);
  return themes ? { themes, usage: out.usage, costCents: out.costCents, model } : null;
}

export async function buildCalendarTask({ payload, runId, db, now, deps = {} }) {
  const person = payload.person;
  if (!person) return { status: 'error', error: 'payload.person is required' };
  const tier = payload.tier || tierFor(person);
  const factFile = payload.context?.factFile ?? (await db.getFactFile(person))?.data ?? null;
  const platforms = payload.platforms
    || (Array.isArray(factFile?.platforms) && factFile.platforms.length ? factFile.platforms : DEFAULT_PLATFORMS);
  const targetRatio = payload.targetRatio != null ? Number(payload.targetRatio) : DEFAULT_TARGET_RATIO;
  const { startIso, endIso } = resolvePeriod(payload.period, now);

  // Themes: provided > model ideation (if asked) > deterministic default.
  let themes = Array.isArray(payload.themes) ? payload.themes.filter(Boolean) : [];
  let modelUsage = null; let modelCost = 0; let modelName = null;
  if (!themes.length && payload.ideate) {
    let ideas;
    try { ideas = await ideateThemes({ person, factFile, db, now, deps }); }
    catch (e) { ideas = null; deps.onError?.(e); }
    if (ideas?.budgetExhausted) {
      return { status: 'budget_exhausted', eventType: 'budget_stop', person,
        reply: `HERALD engine budget exhausted - refusing ideation model call.`, payloadOut: { spent_cents: ideas.spent } };
    }
    if (ideas?.themes) { themes = ideas.themes; modelUsage = ideas.usage; modelCost = ideas.costCents; modelName = ideas.model; }
  }

  const { slots, meta } = buildCalendar({ person, platforms, startIso, endIso, themes, targetRatio, tier, seed: payload.seed });
  const check = validateCalendar(slots);
  if (!check.ok) return { status: 'error', error: `planner produced an invalid slot: ${check.reason}` };

  const planPayload = {
    person, tier, platforms, period: { start: startIso, end: endIso },
    themes: themes.length ? themes : ['(default themes)'],
    target_ratio: targetRatio, caps_version: CAPS_VERSION, slot_count: slots.length,
    slots, generated_by: 'cass', run_id: runId,
  };

  let scheduleId = null;
  if (payload.save !== false) {
    const row = await db.insertSchedule({
      agent: 'cass',
      name: `calendar:${person}:${startIso.slice(0, 10)}_${endIso.slice(0, 10)}`,
      cadence: 'content-calendar',
      mode: 'scheduled',
      payload: planPayload,
      enabled: false,
      sync_state: 'pending',
      created_by: 'cass',
    });
    scheduleId = row?.id || null;
  }

  await db.insertEvent({
    agent: 'cass', person, subject_id: scheduleId,
    event_type: 'calendar.built',
    payload: { runId, tier, platforms, slot_count: slots.length, weeks: meta.weeks,
      per_platform_target: meta.perPlatformTarget, target_ratio: targetRatio, ideated: !!modelName },
  }).catch(() => {});
  if (modelName) {
    await db.insertEvent({ agent: 'cass', person, subject_id: scheduleId, event_type: 'model_call',
      payload: { runId, model: modelName, input_tokens: modelUsage.input_tokens, output_tokens: modelUsage.output_tokens },
      cost_usd: modelCost / 100 }).catch(() => {});
  }

  return {
    status: 'ok', subjectId: scheduleId, person,
    eventType: 'calendar.built',
    usage: modelUsage || { input_tokens: 0, output_tokens: 0 }, costCents: modelCost,
    reply: `Planned ${slots.length} slot(s) across ${platforms.length} platform(s) for ${person} (${tier} tier), ${meta.weeks} week(s), ${CAPS_VERSION} caps.`,
    artifacts: [{ type: 'content_calendar', ref: scheduleId ? `herald_schedules:${scheduleId}` : 'unsaved', data: { slots, meta } }],
    payloadOut: { slot_count: slots.length, platforms, saved: !!scheduleId },
  };
}

// A phased campaign for a goal. Deterministic structure; the calendar preview
// reuses the planner so it inherits every cap + active-hours guarantee.
const PHASES = [
  { key: 'awareness', title: 'Awareness', objective: 'Establish presence + point of view', weight: 0.4 },
  { key: 'consideration', title: 'Consideration', objective: 'Demonstrate depth + relevance', weight: 0.35 },
  { key: 'proof', title: 'Proof', objective: 'Show credibility (compliant tombstones, endorsements)', weight: 0.25 },
];

export async function suggestCampaignTask({ payload, runId, db, now, deps = {} }) {
  const person = payload.person;
  if (!person) return { status: 'error', error: 'payload.person is required' };
  const goal = payload.goal || 'Grow institutional presence';
  const tier = payload.tier || tierFor(person);
  const factFile = payload.context?.factFile ?? (await db.getFactFile(person))?.data ?? null;
  const platforms = payload.platforms
    || (Array.isArray(factFile?.platforms) && factFile.platforms.length ? factFile.platforms : DEFAULT_PLATFORMS);
  const weeks = payload.weeks != null ? Math.max(1, Number(payload.weeks)) : 6;
  const themes = (Array.isArray(payload.themes) && payload.themes.length)
    ? payload.themes
    : ['point of view on capital markets', 'how institutional financing works', 'firm perspective', 'client-outcome proof'];

  const phases = PHASES.map((p, i) => ({
    ...p,
    weeks: Math.max(1, Math.round(weeks * p.weight)),
    platforms,
    ideas: themes.filter((_, ti) => ti % PHASES.length === i).map((t) => ({
      theme: t,
      brief: `[${p.title}] ${t} — draft for ${person}, fact-file-grounded, ${tier} tier.`,
    })),
  }));

  // Cap-safe calendar preview for the whole campaign window (not saved).
  const { startIso, endIso } = resolvePeriod({ weeks }, now);
  const { slots } = buildCalendar({ person, platforms, startIso, endIso, themes, targetRatio: DEFAULT_TARGET_RATIO, tier, seed: payload.seed });

  await db.insertEvent({
    agent: 'cass', person, subject_id: null, event_type: 'campaign.suggested',
    payload: { runId, goal, tier, platforms, weeks, phases: phases.map((p) => p.key), preview_slots: slots.length },
  }).catch(() => {});

  return {
    status: 'ok', person, eventType: 'campaign.suggested',
    reply: `Suggested a ${weeks}-week, ${phases.length}-phase campaign for ${person} toward: ${goal}.`,
    artifacts: [{ type: 'campaign', ref: 'campaign', data: { goal, tier, platforms, weeks, phases, calendar_preview: slots } }],
    payloadOut: { weeks, phase_count: phases.length, preview_slots: slots.length },
  };
}
