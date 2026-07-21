// Gia's three capabilities (OFFICIAL-API rebuild - NO cookies, NO browser):
//   engage             - warm/curated-only reactions + comments on a CURATED list
//                        of TARGET POST URNs. Per target: kill-check FIRST ->
//                        warm-only -> Vera re-verify (comments) -> SPEC-D caps
//                        reserve-then-act -> ONLY IF HERALD_LIVE and the vaulted
//                        token carries w_member_social_feed: POST /rest/reactions
//                        or /rest/socialActions/{urn}/comments. Flag off (or scope
//                        missing/token absent) => dry-run (no API call). Gia does
//                        NOT scan the feed - targets are handed in.
//   manage_company_page - draft -> Vera gate -> content queue (status vera_pass).
//                        Does NOT post: company-page posting needs the pending
//                        Community Management API approval. Queue only.
//   enqueue_follow      - NEVER auto-follow; write a human-tap queue row only.
// Nothing Gia proposes is publishable until Vera passes it (SPEC-H 4).
import {
  RUN_PERSONS, ENGINE_BUDGET_CENTS, ACTION_CLASS, HERALD_LIVE, ENGAGE_REQUIRED_SCOPE,
  DEFAULT_REACTION, oauthSecretName, secrets,
} from './config.mjs';
import { warmthOf } from './engage.mjs';
import * as caps from './caps.mjs';
import { makeKillChecker } from './controls.mjs';
import { fetchToken, markInvalid, scopeHas } from './vault.mjs';
import { pickModel, callModel, companyPagePrompt } from './router.mjs';
import { callVera } from './vera.mjs';
import {
  createReaction as defCreateReaction, createComment as defCreateComment, fetchAuthorUrn as defFetchAuthorUrn,
} from './linkedin.mjs';

const tierFor = (person) => (RUN_PERSONS.includes(person) ? 'run' : 'crawl');
const month = (now) => now.slice(0, 7);
const nowDate = (now) => (now ? new Date(now) : new Date());

// ---- engage: warm/curated-only reactions + comments over the OFFICIAL API -----
export async function engage({ payload, runId, parentRunId, db, now, deps = {} }) {
  const person = payload.person;
  const platform = payload.platform || 'linkedin_personal';
  if (!person) return { status: 'error', error: 'payload.person is required' };
  const live = deps.live != null ? deps.live : HERALD_LIVE;

  // Gia NEVER scans the feed - the caller hands in a curated list of post URNs.
  const targets = normalizeTargets(payload);
  if (!targets.length) {
    return { status: 'error', error: 'engage requires payload.targets[] (or a single payload.target) of curated post URNs' };
  }

  const checkKill = deps.checkKill || makeKillChecker(db);
  const factFile = payload.context?.factFile ?? (await db.getFactFile(person))?.data ?? null;
  const tier = payload.tier || tierFor(person);

  // Resolve the vaulted member token ONCE (every target acts as the same member).
  // Only needed on the live path; a dry-run still surfaces token/scope state.
  const secretArn = deps.secretArn || oauthSecretName(person);
  let accessToken = null; let actorUrn = null; let tokenReason = null; let hasFeedScope = false;
  if (live) {
    const token = await fetchToken({ secretArn, getSecret: deps.getSecret });
    if (!token.ok) { tokenReason = token.reason; await markInvalid({ db, person, reasonCode: token.reason }); }
    else if (token.expired) { tokenReason = 'token_expired'; } // Gia never refreshes; herald-linkedin does
    else {
      accessToken = token.accessToken;
      hasFeedScope = scopeHas(token.scope, ENGAGE_REQUIRED_SCOPE);
      actorUrn = token.authorUrn;
      if (!actorUrn && hasFeedScope) {
        try { actorUrn = (await (deps.fetchAuthorUrn || defFetchAuthorUrn)({ accessToken, fetchImpl: deps.fetch })).authorUrn; }
        catch { actorUrn = null; }
      }
    }
  }

  const results = [];
  let engaged = 0; let skipped = 0; let stopped = null;
  for (const t of targets) {
    // 1) kill-check FIRST (fail-closed), before EVERY target (SPEC-H 5).
    const k = await checkKill(person);
    if (!k.ok) {
      await emitEvent(db, person, runId, k.action === 'kill' ? 'kill_switch.engaged' : 'caps.warning',
        { platform, enforced: true, reason: k.reason });
      stopped = k.action === 'kill' ? 'killed' : 'refused';
      results.push({ target: t.urn || null, status: stopped, reason: k.reason });
      break;
    }
    const r = await engageOne({
      t, person, platform, tier, factFile, runId, parentRunId, db, now, deps,
      live, accessToken, actorUrn, hasFeedScope, tokenReason,
    });
    results.push(r);
    if (r.status === 'engaged' || r.status === 'would_engage') engaged += 1; else skipped += 1;
    if (r.hardStop) { stopped = 'caps_stop'; break; } // SPEC-D would-exceed halts the whole run
  }

  const status = stopped === 'killed' ? 'killed'
    : (stopped === 'refused' ? 'refused'
      : (stopped === 'caps_stop' ? 'caps_stop' : 'ok'));
  const anyLive = results.some((x) => x.status === 'engaged');
  const anyWould = results.some((x) => x.status === 'would_engage');
  return {
    status,
    eventType: status !== 'ok' ? `engage.${status}`
      : (anyLive ? 'engagement.executed' : (anyWould ? 'engagement.cleared' : 'engagement.skipped')),
    person,
    subjectId: results.find((x) => x.subjectId)?.subjectId || null,
    reply: engageReply({ status, engaged, skipped, live }),
    payloadOut: { engaged, skipped, live, count: targets.length, token_reason: tokenReason, results },
  };
}

// One curated target through the full gauntlet. Returns a per-target result;
// { hardStop:true } tells engage() to halt the whole run (SPEC-D).
async function engageOne({ t, person, platform, tier, factFile, runId, parentRunId, db, now, deps, live, accessToken, actorUrn, hasFeedScope, tokenReason }) {
  const action = String(t.action || 'like').toLowerCase();
  const actionClass = ACTION_CLASS[action];
  const targetUrn = t.urn || t.ref || null;
  const emit = (event_type, extra) => emitEvent(db, person, runId, event_type, { platform, action, target_ref: targetUrn, ...extra });

  if (!targetUrn) return { target: null, status: 'skipped', reason: 'no_target_urn' };
  if (!actionClass || !['like', 'comment', 'reply', 'reshare'].includes(actionClass)) {
    await emit('engagement.skipped', { reason: 'unsupported_action' });
    return { target: targetUrn, status: 'skipped', reason: `unsupported_action:${action}` };
  }

  // 2) WARM-ONLY / curated (SPEC-D 1). A cold target is skipped, never reserved.
  const w = warmthOf(t, factFile);
  if (!w.warm) {
    await emit('engagement.skipped', { reason: 'not_warm' });
    return { target: targetUrn, status: 'skipped', reason: 'not_warm' };
  }

  // 3) Vera re-verify for any COMMENT copy (a bare reaction has no content rule,
  //    but it is still logged). A bounce means the comment is not engaged (cap
  //    untouched, no API call).
  let veraVerdict = null; let commentText = null;
  const isComment = actionClass === 'comment' || actionClass === 'reply';
  if (isComment) {
    commentText = t.body || '';
    if (!commentText) return { target: targetUrn, status: 'skipped', reason: 'comment_requires_body' };
    const g = await (deps.callVera || callVera)({
      runId, parentRunId, content: { person, platform, kind: 'comment', body: commentText },
      context: t.context, invokeImpl: deps.veraInvoke,
    });
    veraVerdict = g.vera;
    if (g.verdict !== 'pass') {
      await emit('engagement.bounced', { rule_ids: g.vera.rule_ids });
      return { target: targetUrn, status: 'skipped', reason: 'vera_bounce', verdict: 'bounce', rule_ids: g.vera.rule_ids, bounce: g.vera };
    }
  }

  // 4) SPEC-D reserve-then-act. A hard-stop halts the WHOLE run.
  const res = await caps.reserve(db, { person, platform, actionClass, now: nowDate(now) });
  if (!res.allowed) {
    await emit('caps.stop', { action_class: actionClass, reason: res.reason, window: res.window || null, hard_stop: true });
    return { target: targetUrn, status: 'caps_stop', reason: res.reason, hardStop: true };
  }

  // 5a) DRY-RUN (flag off) OR approval-gate (token missing/expired or scope not
  //     granted): prove the whole path, RELEASE the reservation (a rehearsal or a
  //     gated action must not burn a real slot), record what WOULD engage. NO API.
  const gate = !live ? 'dry_run'
    : (tokenReason || (!hasFeedScope ? 'needs_scope' : (!actorUrn ? 'no_actor_urn' : null)));
  if (gate) {
    await caps.rollback(db, person, platform, actionClass, res.windows).catch(() => {});
    const rowStatus = gate === 'dry_run' ? 'cleared' : 'proposed';
    const row = await recordEngagement(db, { person, platform, actionClass, targetUrn, w, body: commentText, veraVerdict, status: rowStatus, tier });
    await emit(gate === 'dry_run' ? 'engagement.would_engage' : 'engagement.gated',
      { dry_run: true, warm_reason: w.reason, action_class: actionClass, gate, required_scope: ENGAGE_REQUIRED_SCOPE });
    return { target: targetUrn, status: 'would_engage', reason: gate, subjectId: row?.id || null, warm_reason: w.reason };
  }

  // 5b) LIVE: call the OFFICIAL LinkedIn API, commit the slot on success.
  let apiRef = null;
  try {
    if (isComment) {
      const out = await (deps.createComment || defCreateComment)({ accessToken, actorUrn, targetUrn, message: commentText, fetchImpl: deps.fetch });
      apiRef = out.commentUrn || 'commented';
    } else {
      const out = await (deps.createReaction || defCreateReaction)({ accessToken, actorUrn, targetUrn, reactionType: t.reactionType || DEFAULT_REACTION, fetchImpl: deps.fetch });
      apiRef = out.reactionId || `reacted:${out.reactionType}`;
    }
  } catch (e) {
    await caps.rollback(db, person, platform, actionClass, res.windows).catch(() => {});
    await emit('engagement.failed', { reason: e.message, status: e.status || null });
    return { target: targetUrn, status: 'error', reason: e.message };
  }
  await caps.commit(db, person, platform, actionClass, res.windows).catch(() => {});
  const row = await recordEngagement(db, { person, platform, actionClass, targetUrn, w, body: commentText, veraVerdict, status: 'executed', tier, externalRef: apiRef, executed: true });
  await emit('engagement.executed', { warm_reason: w.reason, action_class: actionClass, external_ref: apiRef, dry_run: false });
  return { target: targetUrn, status: 'engaged', subjectId: row?.id || null, warm_reason: w.reason, external_ref: apiRef };
}

// Normalize input to a curated target list. Back-compat: a single
// { target, action, body } still works; a bare URN string is accepted too.
function normalizeTargets(payload) {
  if (Array.isArray(payload.targets) && payload.targets.length) {
    return payload.targets.map((t) => normalizeOne(t, payload, true));
  }
  if (payload.target || payload.urn) {
    const base = (payload.target && typeof payload.target === 'object') ? payload.target : {};
    return [normalizeOne({ ...base, urn: base.urn || base.ref || payload.urn, action: payload.action, body: payload.body }, payload, false)];
  }
  return [];
}
function normalizeOne(t, payload, isList) {
  const o = (t && typeof t === 'object') ? { ...t } : { urn: String(t) };
  o.urn = o.urn || o.ref || null;
  o.action = o.action || payload.action || 'like';
  if (o.body == null && !isList && payload.body != null) o.body = payload.body;
  return o;
}

// Only warm targets that pass every gate get a queue row: 'executed' (live),
// 'cleared' (dry-run rehearsal), or 'proposed' (approval-gated). Cold/bounced
// targets are event-only (no row). Columns match migration 0005; a failed insert
// never fails the run (audit is best-effort).
async function recordEngagement(db, { person, platform, actionClass, targetUrn, w, body, veraVerdict, status, tier, externalRef = null, executed = false }) {
  const row = {
    person, platform, action_class: actionClass, target_ref: targetUrn, target_kind: 'post',
    warm_reason: w.reason, body: body || null, vera_verdict: veraVerdict || null,
    status, tier, created_by: 'gia', external_ref: externalRef,
  };
  if (executed) row.executed_at = new Date().toISOString();
  try { return await db.insertEngagement(row); } catch { return null; }
}
async function emitEvent(db, person, runId, event_type, payload) {
  return db.insertEvent({ agent: 'gia', person, event_type, payload: { runId, ...payload } }).catch(() => {});
}
function engageReply({ status, engaged, skipped, live }) {
  if (status === 'killed') return 'HERALD kill switch engaged - engage run halted (kill_enforced).';
  if (status === 'refused') return 'HERALD pause engaged - engage run halted.';
  if (status === 'caps_stop') return `SPEC-D caps hard-stop - engage run halted after ${engaged} engaged.`;
  return `${live ? 'Engaged' : 'Would engage (dry-run)'} ${engaged}, skipped ${skipped}.`;
}

// ---- manage_company_page: draft -> Vera -> content queue (NEVER posts) -------
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

  // Draft lands in the content queue. Company-page POSTING is intentionally NOT
  // implemented here - it needs the pending Community Management API approval.
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
    runId, parentRunId, content: { person, platform, kind: 'post', body },
    context: payload.context, invokeImpl: deps.veraInvoke,
  });
  const status = g.verdict === 'pass' ? 'vera_pass' : 'bounced';
  await db.patchQueueItem(row.id, { status, vera_verdict: g.vera, updated_at: new Date().toISOString() }).catch(() => {});
  await db.insertEvent({ agent: 'gia', person, subject_id: row.id,
    event_type: g.verdict === 'pass' ? 'content.vera_pass' : 'content.vera_bounce',
    payload: { runId, tier, rule_ids: g.vera.rule_ids, blocked: !!g.blocked, posts: false } }).catch(() => {});
  return {
    status: 'ok', verdict: g.verdict, subjectId: row.id, person,
    eventType: g.verdict === 'pass' ? 'content.vera_pass' : 'content.vera_bounce',
    usage: usage || undefined, model: model || undefined, costCents,
    reply: g.verdict === 'pass'
      ? `Company-page post drafted + cleared (${tier}); QUEUED as vera_pass (not posted - Community Management API pending).`
      : `Company-page draft bounced: ${g.vera.bounce_reasons.join('; ') || g.vera.rule_ids.join(', ')}.`,
    payloadOut: { status, tier, rule_ids: g.vera.rule_ids, posts: false },
    bounce: g.verdict === 'bounce' ? g.vera : null,
  };
}

// ---- enqueue_follow: NEVER auto-follow; human-tap queue row only -------------
export async function enqueueFollow({ payload, runId, db, now, deps = {} }) {
  const person = payload.person;
  const platform = payload.platform;
  const target = payload.target || {};
  if (!person || !platform) return { status: 'error', error: 'payload.person and payload.platform are required' };
  if (!target.ref && !target.handle && !target.urn) return { status: 'error', error: 'enqueue_follow requires target.ref/handle/urn' };
  const tier = payload.tier || tierFor(person);
  const factFile = payload.context?.factFile ?? (await db.getFactFile(person))?.data ?? null;
  const w = warmthOf(target, factFile);

  // HARD RULE: follows are DISABLED for automation (SPEC-D 4/6 - X automated
  // follow is ToS-violating; LinkedIn follow-automation stays human-tap too). Gia
  // NEVER reserves a follow cap and NEVER executes a follow. It writes a human_tap
  // row for one-tap human execution and stops.
  const row = await db.insertEngagement({
    person, platform, action_class: 'follow',
    target_ref: target.ref || target.handle || target.urn, target_kind: target.kind || 'account',
    warm_reason: w.warm ? w.reason : null, body: null, vera_verdict: null,
    status: 'human_tap', tier, created_by: 'gia', external_ref: null,
  });
  await db.insertEvent({ agent: 'gia', person, subject_id: row.id, event_type: 'engagement.human_tap',
    payload: { runId, platform, action_class: 'follow', auto: false, target_ref: target.ref || target.handle || target.urn } }).catch(() => {});
  return {
    status: 'ok', eventType: 'engagement.human_tap', person, subjectId: row.id,
    reply: `Follow routed to the human-tap queue (never auto-followed) for ${person}/${platform}.`,
    payloadOut: { human_tap: true, auto: false, action_class: 'follow' },
  };
}
