// Nico's two capabilities: draft_post (write copy -> Vera gate -> queue row) and
// redraft (consume a bounced row, climb to Opus, re-enter the Vera gate as a NEW
// row with parent_id lineage). Nothing Nico writes is publishable until Vera
// passes it (SPEC-H section 4). The Vera gate is NEVER skipped.
import {
  RUN_PERSONS, ENGINE_BUDGET_CENTS, MODEL_DEFAULT, secrets,
} from './config.mjs';
import { pickModel, callModel, systemPromptFor } from './router.mjs';
import { callVera } from './vera.mjs';

const tierFor = (person) => (RUN_PERSONS.includes(person) ? 'run' : 'crawl');
const month = (now) => now.slice(0, 7);

// SPEC-G section 4: on a Vera PASS the row enters 'vera_pass'. Run-tier
// (Ashton/Jasmine) is auto-approvable downstream by herald-decide; crawl-tier
// waits in the dashboard "Needs you" inbox for an explicit human approval
// (SPEC-G 4.1.3). Nico only stamps the tier - it never auto-approves. Unsigned
// crawl persons never reach a pass at all: Vera's VERA-N03 bounces them, which
// is the "held as draft, needs human" state the roster gate describes (SPEC-I).
const passStatus = () => 'vera_pass';

async function generate({ person, platform, kind, brief, factFile, isRedraft, deps }) {
  const model = pickModel({ brief, kind, hard: deps.hard, isRedraft });
  const key = (await secrets())['anthropic-key'];
  const system = systemPromptFor({ person, factFile, platform });
  const call = deps.callModel || callModel;
  const out = await call({ model, system, user: brief, anthropicKey: key, maxTokens: deps.maxTokens || 1024, fetchImpl: deps.fetch });
  return { model, ...out };
}

// Shared tail: run the Vera gate on freshly generated content and finalize the
// queue row + verdict event. `row` already exists at status 'draft'.
async function gateAndFinalize({ row, item, tier, runId, parentRunId, db, deps }) {
  const call = deps.callVera || callVera;
  const g = await call({
    runId, parentRunId,
    content: { person: item.person, platform: item.platform, kind: item.kind, body: item.body },
    context: item.context, invokeImpl: deps.veraInvoke,
  });
  const status = g.verdict === 'pass' ? passStatus() : 'bounced';
  await db.patchQueueItem(row.id, { status, vera_verdict: g.vera, updated_at: new Date().toISOString() });
  await db.insertEvent({
    agent: 'nico', person: item.person, subject_id: row.id,
    event_type: g.verdict === 'pass' ? 'content.vera_pass' : 'content.vera_bounce',
    payload: { runId, tier, rule_ids: g.vera.rule_ids, blocked: !!g.blocked },
  }).catch(() => {});
  return { status, verdict: g.verdict, vera: g.vera };
}

export async function draftPost({ payload, runId, parentRunId, db, now, deps = {} }) {
  const person = payload.person;
  const platform = payload.platform;
  const brief = payload.brief || payload.topic || '';
  const kind = payload.kind || 'post';
  if (!person || !platform) return { status: 'error', error: 'payload.person and payload.platform are required' };
  if (!brief) return { status: 'error', error: 'payload.brief (or payload.topic) is required' };
  const tier = payload.tier || tierFor(person);

  // Engine-wide $400/mo hard stop (SPEC-B 6A) - checked BEFORE the model call.
  let spent = 0;
  try { spent = await db.monthSpendCents(month(now)); } catch { spent = 0; }
  if (spent >= ENGINE_BUDGET_CENTS) {
    return { status: 'budget_exhausted', eventType: 'budget_stop', person,
      reply: `HERALD engine budget exhausted ($${(spent / 100).toFixed(2)} >= cap) - refusing model call.`,
      payloadOut: { spent_cents: spent } };
  }

  const factFile = payload.context?.factFile ?? (await db.getFactFile(person))?.data ?? null;
  let gen;
  try { gen = await generate({ person, platform, kind, brief, factFile, isRedraft: false, deps }); }
  catch (e) { return { status: 'error', error: `model call failed: ${e.message}` }; }

  const item = { person, platform, kind, body: gen.text, context: payload.context };
  const row = await db.insertQueueItem({
    person, platform, kind, body: gen.text, tier, status: 'draft', created_by: 'nico',
  });
  await db.insertEvent({ agent: 'nico', person, subject_id: row.id, event_type: 'content.drafted',
    payload: { runId, tier, model: gen.model } }).catch(() => {});
  await db.insertEvent({ agent: 'nico', person, subject_id: row.id, event_type: 'model_call',
    payload: { runId, model: gen.model, input_tokens: gen.usage.input_tokens, output_tokens: gen.usage.output_tokens },
    cost_usd: gen.costCents / 100 }).catch(() => {});

  const fin = await gateAndFinalize({ row, item, tier, runId, parentRunId, db, deps });
  return {
    status: 'ok', verdict: fin.verdict, subjectId: row.id, person,
    eventType: fin.verdict === 'pass' ? 'content.vera_pass' : 'content.vera_bounce',
    usage: gen.usage, model: gen.model, costCents: gen.costCents,
    reply: fin.verdict === 'pass'
      ? `Drafted + cleared (${tier}); queued as vera_pass.`
      : `Drafted but bounced: ${fin.vera.bounce_reasons.join('; ') || fin.vera.rule_ids.join(', ')}.`,
    payloadOut: { status: fin.status, tier, rule_ids: fin.vera.rule_ids },
    bounce: fin.verdict === 'bounce' ? fin.vera : null,
  };
}

// redraft: consume a bounced row and try again. Climbs to Opus (isRedraft) and
// feeds Vera's bounce reasons + suggested rewrite into the brief. The new draft
// is a NEW row with parent_id = the bounced row (immutable lineage, SPEC-G 4.3).
export async function redraft({ payload, runId, parentRunId, db, now, deps = {} }) {
  let parent = null;
  if (payload.bouncedId) parent = await db.getQueueItem(payload.bouncedId);
  else parent = (await db.listBounced(1))[0] || null;
  if (!parent) return { status: 'error', error: 'no bounced item to redraft (pass payload.bouncedId or ensure a bounced row exists)' };
  if (parent.status !== 'bounced') return { status: 'error', error: `parent ${parent.id} is not bounced (status=${parent.status})` };

  const person = parent.person;
  const tier = parent.tier || tierFor(person);
  let spent = 0;
  try { spent = await db.monthSpendCents(month(now)); } catch { spent = 0; }
  if (spent >= ENGINE_BUDGET_CENTS) {
    return { status: 'budget_exhausted', eventType: 'budget_stop', person, payloadOut: { spent_cents: spent } };
  }

  const factFile = payload.context?.factFile ?? (await db.getFactFile(person))?.data ?? null;
  const reasons = (parent.vera_verdict?.bounce_reasons || []).join('\n');
  const fix = parent.vera_verdict?.suggested_rewrite || '';
  const brief = [
    `Rewrite this ${parent.platform} ${parent.kind} for ${person}. The prior draft was BOUNCED by compliance.`,
    `Prior draft:\n${parent.body}`,
    reasons ? `Bounce reasons:\n${reasons}` : '',
    fix ? `Suggested fix:\n${fix}` : '',
    `Produce a corrected version that resolves every bounce reason.`,
  ].filter(Boolean).join('\n\n');

  let gen;
  try { gen = await generate({ person, platform: parent.platform, kind: parent.kind, brief, factFile, isRedraft: true, deps }); }
  catch (e) { return { status: 'error', error: `model call failed: ${e.message}` }; }

  const row = await db.insertQueueItem({
    person, platform: parent.platform, kind: parent.kind, body: gen.text, tier,
    status: 'draft', created_by: 'nico', parent_id: parent.id,
  });
  await db.insertEvent({ agent: 'nico', person, subject_id: row.id, event_type: 'content.redrafted',
    payload: { runId, parent_id: parent.id, model: gen.model } }).catch(() => {});
  await db.insertEvent({ agent: 'nico', person, subject_id: row.id, event_type: 'model_call',
    payload: { runId, model: gen.model, input_tokens: gen.usage.input_tokens, output_tokens: gen.usage.output_tokens },
    cost_usd: gen.costCents / 100 }).catch(() => {});

  const item = { person, platform: parent.platform, kind: parent.kind, body: gen.text, context: payload.context };
  const fin = await gateAndFinalize({ row, item, tier, runId, parentRunId, db, deps });
  return {
    status: 'ok', verdict: fin.verdict, subjectId: row.id, person,
    eventType: fin.verdict === 'pass' ? 'content.vera_pass' : 'content.vera_bounce',
    usage: gen.usage, model: gen.model, costCents: gen.costCents,
    reply: fin.verdict === 'pass' ? `Redraft of ${parent.id} cleared.` : `Redraft of ${parent.id} bounced again.`,
    payloadOut: { status: fin.status, parent_id: parent.id, rule_ids: fin.vera.rule_ids },
    bounce: fin.verdict === 'bounce' ? fin.vera : null,
  };
}
