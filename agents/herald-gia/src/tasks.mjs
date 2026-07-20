// Gia's three capabilities:
//   engage             - warm-only like/comment; reserve-then-act; would-exceed = full stop.
//   manage_company_page - draft a company-page post -> Vera gate -> content queue.
//   enqueue_follow      - NEVER auto-follow; write a human-tap queue row for one-tap human execution.
// Nothing Gia proposes for publication is publishable until Vera passes it
// (SPEC-H 4). The Vera gate is NEVER skipped for comment copy or page drafts.
import {
  RUN_PERSONS, ENGINE_BUDGET_CENTS, ACTION_CLASS, secrets,
} from './config.mjs';
import { warmthOf } from './engage.mjs';
import * as caps from './caps.mjs';
import { pickModel, callModel, companyPagePrompt } from './router.mjs';
import { callVera } from './vera.mjs';

const tierFor = (person) => (RUN_PERSONS.includes(person) ? 'run' : 'crawl');
const month = (now) => now.slice(0, 7);
const nowDate = (now) => (now ? new Date(now) : new Date());

// ---- engage: warm-only like/comment, reserve-then-act -----------------------
export async function engage({ payload, runId, parentRunId, db, now, deps = {} }) {
  const person = payload.person;
  const platform = payload.platform;
  const action = payload.action || 'like';
  const target = payload.target || {};
  if (!person || !platform) return { status: 'error', error: 'payload.person and payload.platform are required' };
  const actionClass = ACTION_CLASS[action];
  if (!actionClass || !['like', 'comment', 'reshare', 'reply'].includes(actionClass)) {
    return { status: 'error', error: `engage supports like/comment/reshare/reply, not "${action}"` };
  }
  const tier = payload.tier || tierFor(person);
  const factFile = payload.context?.factFile ?? (await db.getFactFile(person))?.data ?? null;

  // RULE 1 - WARM-ONLY (SPEC-D 1). A cold target is skipped, never engaged,
  // never reserved. This is the acceptance-rate guardrail, not a soft nudge.
  const w = warmthOf(target, factFile);
  if (!w.warm) {
    await db.insertEvent({ agent: 'gia', person, event_type: 'engagement.skipped',
      payload: { runId, platform, action, reason: 'not_warm', target_ref: target.ref || null } }).catch(() => {});
    return { status: 'ok', eventType: 'engagement.skipped', person,
      reply: `Cold target skipped (warm-only). ${action} not proposed.`,
      payloadOut: { engaged: false, skipped: 'not_warm' } };
  }

  // Comment copy is content -> it MUST pass the Vera gate before it can be
  // cleared. A bounce means the comment is not engaged (and the cap is untouched).
  let veraVerdict = null;
  if (actionClass === 'comment') {
    const body = payload.body || '';
    if (!body) return { status: 'error', error: 'comment engage requires payload.body' };
    const g = await (deps.callVera || callVera)({
      runId, parentRunId,
      content: { person, platform, kind: 'comment', body },
      context: payload.context, invokeImpl: deps.veraInvoke,
    });
    veraVerdict = g.vera;
    if (g.verdict !== 'pass') {
      await db.insertEvent({ agent: 'gia', person, event_type: 'engagement.bounced',
        payload: { runId, platform, action, rule_ids: g.vera.rule_ids, target_ref: target.ref || null } }).catch(() => {});
      return { status: 'ok', eventType: 'engagement.bounced', person, verdict: 'bounce',
        reply: `Comment bounced by Vera: ${g.vera.bounce_reasons.join('; ') || g.vera.rule_ids.join(', ')}.`,
        payloadOut: { engaged: false, skipped: 'vera_bounce', rule_ids: g.vera.rule_ids }, bounce: g.vera };
    }
  }

  // RULE 2 - RESERVE-THEN-ACT with HARD-STOP (SPEC-D 7). Reserve the cap BEFORE
  // clearing the engagement. A would-exceed on ANY window aborts the WHOLE run.
  const res = await caps.reserve(db, { person, platform, actionClass, now: nowDate(now) });
  if (!res.allowed) {
    await db.insertEvent({ agent: 'gia', person, event_type: 'caps.stop',
      payload: { runId, platform, action_class: actionClass, reason: res.reason, window: res.window || null, hard_stop: true } }).catch(() => {});
    return { status: 'caps_stop', eventType: 'caps.stop', person,
      reply: `Caps hard-stop (${res.reason}) - whole engage run halted for ${person}/${platform}.`,
      payloadOut: { engaged: false, reason: res.reason, action_class: actionClass } };
  }

  // Cleared for execution. Gia records the engagement (a browser executor picks
  // it up downstream); it performs NO real action itself. Commit consumes the
  // slot (conservative - the cap is spoken for the moment the engagement is queued).
  let row;
  try {
    row = await db.insertEngagement({
      person, platform, action_class: actionClass, target_ref: target.ref || null,
      target_kind: target.kind || null, warm_reason: w.reason, body: payload.body || null,
      vera_verdict: veraVerdict, status: 'cleared', tier, created_by: 'gia',
    });
  } catch (e) {
    await caps.rollback(db, person, platform, actionClass, res.windows).catch(() => {});
    return { status: 'error', error: `engagement record failed: ${e.message}` };
  }
  await caps.commit(db, person, platform, actionClass, res.windows).catch(() => {});
  await db.insertEvent({ agent: 'gia', person, subject_id: row.id, event_type: 'engagement.cleared',
    payload: { runId, platform, action_class: actionClass, warm_reason: w.reason, dry_run: true, target_ref: target.ref || null } }).catch(() => {});
  return {
    status: 'ok', eventType: 'engagement.cleared', person, subjectId: row.id, verdict: veraVerdict ? 'pass' : null,
    reply: `Warm ${action} cleared (${w.reason}); queued for execution (dry-run - no live action).`,
    payloadOut: { engaged: true, warm_reason: w.reason, action_class: actionClass },
  };
}

// ---- manage_company_page: draft -> Vera -> content queue --------------------
export async function manageCompanyPage({ payload, runId, parentRunId, db, now, deps = {} }) {
  const person = payload.person;
  const platform = 'linkedin_company';
  if (!person) return { status: 'error', error: 'payload.person (the signed-off page admin) is required' };
  const tier = payload.tier || tierFor(person);
  const factFile = payload.context?.factFile ?? (await db.getFactFile(person))?.data ?? null;

  let body = payload.body || null;
  let usage = null; let model = null; let costCents = 0;
  if (!body) {
    // Generate the draft (only path that spends model tokens). Engine-wide
    // $400/mo hard stop (SPEC-B 6A) is checked BEFORE the model call.
    let spent = 0;
    try { spent = await db.monthSpendCents(month(now)); } catch { spent = 0; }
    if (spent >= ENGINE_BUDGET_CENTS) {
      return { status: 'budget_exhausted', eventType: 'budget_stop', person,
        reply: `HERALD engine budget exhausted ($${(spent / 100).toFixed(2)} >= cap) - refusing model call.`,
        payloadOut: { spent_cents: spent } };
    }
    const brief = payload.brief || payload.topic || '';
    if (!brief) return { status: 'error', error: 'manage_company_page requires payload.body or payload.brief' };
    const chosen = pickModel({ brief, hard: deps.hard });
    const key = (await secrets())['anthropic-key'];
    try {
      const out = await (deps.callModel || callModel)({
        model: chosen, system: companyPagePrompt({ person, factFile }), user: brief,
        anthropicKey: key, maxTokens: deps.maxTokens || 1024, fetchImpl: deps.fetch });
      body = out.text; usage = out.usage; model = out.model; costCents = out.costCents;
    } catch (e) { return { status: 'error', error: `model call failed: ${e.message}` }; }
  }

  const row = await db.insertQueueItem({
    person, platform, kind: 'post', title: payload.title || null, body,
    tier, status: 'draft', created_by: 'gia',
  });
  if (model) {
    await db.insertEvent({ agent: 'gia', person, subject_id: row.id, event_type: 'model_call',
      payload: { runId, model, input_tokens: usage?.input_tokens || 0, output_tokens: usage?.output_tokens || 0 },
      cost_usd: costCents / 100 }).catch(() => {});
  }
  const g = await (deps.callVera || callVera)({
    runId, parentRunId,
    content: { person, platform, kind: 'post', body },
    context: payload.context, invokeImpl: deps.veraInvoke,
  });
  const status = g.verdict === 'pass' ? 'vera_pass' : 'bounced';
  await db.patchQueueItem(row.id, { status, vera_verdict: g.vera, updated_at: new Date().toISOString() }).catch(() => {});
  await db.insertEvent({ agent: 'gia', person, subject_id: row.id,
    event_type: g.verdict === 'pass' ? 'content.vera_pass' : 'content.vera_bounce',
    payload: { runId, tier, rule_ids: g.vera.rule_ids, blocked: !!g.blocked } }).catch(() => {});
  return {
    status: 'ok', verdict: g.verdict, subjectId: row.id, person,
    eventType: g.verdict === 'pass' ? 'content.vera_pass' : 'content.vera_bounce',
    usage: usage || undefined, model: model || undefined, costCents,
    reply: g.verdict === 'pass'
      ? `Company-page post drafted + cleared (${tier}); queued as vera_pass.`
      : `Company-page draft bounced: ${g.vera.bounce_reasons.join('; ') || g.vera.rule_ids.join(', ')}.`,
    payloadOut: { status, tier, rule_ids: g.vera.rule_ids },
    bounce: g.verdict === 'bounce' ? g.vera : null,
  };
}

// ---- enqueue_follow: NEVER auto-follow; human-tap queue row only ------------
export async function enqueueFollow({ payload, runId, db, now, deps = {} }) {
  const person = payload.person;
  const platform = payload.platform;
  const target = payload.target || {};
  if (!person || !platform) return { status: 'error', error: 'payload.person and payload.platform are required' };
  if (!target.ref && !target.handle) return { status: 'error', error: 'enqueue_follow requires target.ref or target.handle' };
  const tier = payload.tier || tierFor(person);
  const factFile = payload.context?.factFile ?? (await db.getFactFile(person))?.data ?? null;
  const w = warmthOf(target, factFile);

  // HARD RULE: follows are DISABLED for automation (SPEC-D 4/6 - X automated
  // follow is ToS-violating; all follows appear as human-tap suggestions). Gia
  // NEVER reserves a follow cap and NEVER clears/executes a follow. It writes a
  // human_tap row for one-tap human execution and stops.
  const row = await db.insertEngagement({
    person, platform, action_class: 'follow',
    target_ref: target.ref || target.handle, target_kind: target.kind || 'account',
    warm_reason: w.warm ? w.reason : null, body: null, vera_verdict: null,
    status: 'human_tap', tier, created_by: 'gia',
  });
  await db.insertEvent({ agent: 'gia', person, subject_id: row.id, event_type: 'engagement.human_tap',
    payload: { runId, platform, action_class: 'follow', auto: false, target_ref: target.ref || target.handle } }).catch(() => {});
  return {
    status: 'ok', eventType: 'engagement.human_tap', person, subjectId: row.id,
    reply: `Follow routed to the human-tap queue (never auto-followed) for ${person}/${platform}.`,
    payloadOut: { human_tap: true, auto: false, action_class: 'follow' },
  };
}
