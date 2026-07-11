// Vera's three capabilities: review_content (the 35-rule gate), watch_live
// (re-check what actually shipped - input carries the fetched content, Vera
// does not browse), kill_switch (admin-only herald_controls write).
import { evaluate } from './engine.mjs';
import { RULESET_VERSION } from './rules.mjs';
import { LLM_BRAND_PASS } from './config.mjs';

// Whitespace/emoji-encoding tolerant normalization for the live-watch diff
// (SPEC-E section 5.3).
const normText = (s) => String(s ?? '')
  .normalize('NFKC')
  .replace(/[︎️​-‍]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const numTokens = (s) => (String(s ?? '').match(/\$?\d[\d,.]*%?/g) || []).map((x) => x.replace(/[,\s]/g, ''));
const dateTokens = (s) => String(s ?? '').match(/\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/gi) || [];
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function loadItem(payload, db) {
  if (payload.content) return { item: { ...payload.content }, row: null };
  if (!payload.contentId) return { item: null, row: null };
  const row = await db.getQueueItem(payload.contentId);
  if (!row) return { item: null, row: null };
  return {
    item: {
      id: row.id, person: row.person, platform: row.platform, kind: row.kind,
      title: row.title, body: row.body, citations: payload.citations || [],
    },
    row,
  };
}

function buildCtx(payload, factFile, now) {
  const c = payload.context || {};
  return {
    factFile,
    factFiles: c.factFiles,
    clients: c.clients,
    deal: c.deal,
    subjectCapabilities: c.subjectCapabilities,
    action: c.action,
    caps: c.caps,
    recentTexts: c.recentTexts,
    piiAllowlist: c.piiAllowlist,
    systemOfRecordDate: c.systemOfRecordDate,
    llmBrandPass: LLM_BRAND_PASS,
    now,
  };
}

// ---- review_content: the pre-publish gate. Nothing publishes around her. ----
export async function reviewContent({ payload, db, now }) {
  const { item, row } = await loadItem(payload, db);
  if (!item) return { status: 'error', error: 'content not found (pass payload.content or a valid payload.contentId)' };
  if (!item.body || !item.person) return { status: 'error', error: 'content.body and content.person are required' };
  const factFile = payload.context?.factFile ?? (await db.getFactFile(item.person))?.data ?? null;
  const v = evaluate(item, buildCtx(payload, factFile, now));
  if (row) {
    // Only Vera writes vera_verdict (SPEC-G 3.1.2). Bounced rows are terminal;
    // Nico redrafts into a NEW row with parent_id.
    const vera_verdict = {
      verdict: v.verdict, at: v.checked_at, gates: v.gates,
      bounce_reasons: v.quotes.map((q) => `${q.rule_id}: "${q.quote}"`),
      suggested_rewrite: v.suggested_fix,
      model: 'deterministic', version: RULESET_VERSION,
      rule_ids: v.rule_ids, hold_for_human: v.hold_for_human,
    };
    await db.patchQueueItem(row.id, {
      status: v.verdict === 'pass' ? 'vera_pass' : 'bounced',
      vera_verdict, updated_at: new Date().toISOString(),
    });
  }
  return {
    status: 'ok', verdict: v.verdict, bounce: v,
    reply: v.verdict === 'pass'
      ? `Pass (ruleset v${RULESET_VERSION})${v.hold_for_human ? ' - held for human review: ' + v.flag_ids.join(', ') : ''}.`
      : `Bounce: ${v.rule_ids.join(', ')}. ${v.suggested_fix || ''}`.trim(),
    eventType: v.verdict === 'pass' ? 'content.vera_pass' : 'content.vera_bounce',
    subjectId: row?.id || null, person: item.person,
  };
}

// ---- watch_live: pre-publish clearance is necessary but not sufficient. ----
// Same engine, same ruleset_version, two moments. The caller supplies the
// fetched live content - Vera does not browse (that is Piper's runtime).
export async function watchLive({ payload, db, now }) {
  const live = payload.live;
  if (!live?.body) return { status: 'error', error: 'payload.live.body required (caller fetches; Vera does not browse)' };
  let approvedBody = payload.approvedBody ?? null;
  let row = null;
  if (approvedBody == null && payload.contentId) {
    row = await db.getQueueItem(payload.contentId);
    approvedBody = row?.body ?? null;
  }
  const person = payload.person || row?.person || null;
  const factFile = payload.context?.factFile ?? (person ? (await db.getFactFile(person))?.data ?? null : null);
  const item = {
    id: payload.contentId || null, person,
    platform: payload.platform || row?.platform, kind: row?.kind || 'post',
    body: live.body, citations: payload.citations || [],
  };
  const v = evaluate(item, buildCtx(payload, factFile, now));
  const drift = approvedBody != null && normText(approvedBody) !== normText(live.body);
  const numericDrift = drift && !sameSet(numTokens(approvedBody), numTokens(live.body));
  const dateDrift = drift && !sameSet(dateTokens(approvedBody), dateTokens(live.body));
  const liveBlock = v.verdict === 'bounce';
  // SPEC-E 5.5 escalation: block-severity live hit, or drift on the
  // highest-liability fields (numbers, dates) -> pause the person's scope.
  const escalate = liveBlock || numericDrift || dateDrift;
  if (escalate && person) {
    await db.upsertControl({
      scope: `user:${person}`, state: 'pause',
      reason: `live-watch escalation:${liveBlock ? ' block-severity live hit' : ''}${numericDrift ? ' numeric drift' : ''}${dateDrift ? ' date drift' : ''}`,
      set_by: 'agent:vera', set_at: new Date().toISOString(),
    });
  }
  return {
    status: 'ok', verdict: v.verdict, bounce: v,
    drift, numericDrift, dateDrift, escalated: escalate,
    reply: escalate
      ? `LIVE-WATCH ESCALATION for ${person || 'unknown'}: ${liveBlock ? 'live rule hit ' + v.rule_ids.join(', ') : 'high-liability drift'} - scope paused.`
      : drift ? 'Drift detected (non-escalating) - alert only.' : 'Live content matches the approved draft.',
    eventType: escalate || drift ? 'livewatch.violation' : 'livewatch.ok',
    subjectId: payload.contentId || row?.id || null, person,
    payloadOut: { drift, numericDrift, dateDrift, escalated: escalate },
  };
}

// ---- kill_switch: writes herald_controls. Admin dashboard actors only. ----
export async function killSwitch({ payload, actor, db }) {
  if (actor.type !== 'user' || !['admin', 'super_admin'].includes(actor.role)) {
    return { status: 'refused', error: 'kill_switch requires an admin dashboard actor (Supabase JWT with admin role)' };
  }
  const state = payload.state;
  if (!['run', 'pause', 'kill'].includes(state)) return { status: 'error', error: 'payload.state must be run|pause|kill' };
  const scope = payload.scope || 'global';
  await db.upsertControl({
    scope, state, reason: payload.reason || null,
    set_by: actor.email || actor.userId, set_at: new Date().toISOString(),
  });
  return {
    status: 'ok', verdict: null,
    reply: `herald_controls ${scope} -> ${state}`,
    eventType: state === 'run' ? 'kill_switch.released' : 'kill_switch.engaged',
    payloadOut: { scope, state, reason: payload.reason || null },
  };
}
