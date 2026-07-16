// herald-cass Lambda handler (Function URL, AWS_IAM transport auth).
//   GET  /manifest -> AGT-2 manifest (SPEC-B 7.1)
//   POST /invoke   -> SPEC-B 7.2 envelope -> SPEC-B 7.3 response
// Handler order on EVERY invoke (SPEC-B 7.2 + SPEC-H 5): parse -> kill-switch
// FIRST (fail closed) -> app auth (Supabase JWT for the dashboard "plan" action;
// mode='scheduled' is an EventBridge system actor, already IAM-proven at the
// Function URL; peer callers via ALLOWED_CALLERS) -> chain rules -> task ->
// herald_events + herald_runs + agent_usage. Cass only spends model tokens on
// optional theme ideation; the ledger row carries the real cost.
import { randomUUID } from 'node:crypto';
import { authorize } from './auth.mjs';
import { makeDb } from './db.mjs';
import { buildCalendarTask, suggestCampaignTask } from './tasks.mjs';
import { ALLOWED_CALLERS, MAX_CHAIN_DEPTH, SERVICE, AGENT, MODEL_DEFAULT, MODEL_ESCALATION } from './config.mjs';

export const MANIFEST = {
  service: 'herald-cass', agent: 'cass', engine: 'herald', version: '1.0.0',
  capabilities: ['build_calendar', 'suggest_campaign'],
  models: { default: MODEL_DEFAULT, escalation: MODEL_ESCALATION },
  cost_class: 'low', deterministic_only: false,
  auth: { transport: 'aws_iam_function_url', app: 'supabase_jwt+ecosystem_user_grants|scheduled' },
  invoke: {
    method: 'POST', path: '/invoke',
    envelope: {
      runId: 'uuid', mode: 'chat|task|scheduled', task: 'string?', sessionId: 'uuid?',
      actor: { userId: 'uuid', onBehalfOf: 'uuid?' }, payload: 'object',
      trace: { chain: 'string[]', parentRunId: 'uuid?' },
    },
  },
  variant: 'lambda', kill_switch_scopes: ['global', 'agent', 'user'], owner: 'centurionfinancial.com',
};

const TASKS = { build_calendar: buildCalendarTask, suggest_campaign: suggestCampaignTask };
const MODES = ['chat', 'task', 'scheduled'];

export function createHandler(deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const auth = deps.authorize || ((b) => authorize(b, fetchImpl));
  const getDb = deps.makeDb || (() => makeDb(fetchImpl));
  const nowFn = deps.now || (() => new Date().toISOString());
  const taskDeps = deps.taskDeps || {};

  return async function handler(event) {
    const isHttp = !!event?.requestContext?.http;
    const json = (status, body) => (isHttp
      ? { statusCode: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { statusCode: status, ...body });

    if (isHttp) {
      const method = event.requestContext.http.method || 'POST';
      const path = event.rawPath || '/';
      if (method === 'GET' && path.endsWith('/manifest')) return json(200, MANIFEST);
      if (method !== 'POST') return json(404, { error: 'not found' });
    } else if (event?.manifest === true) {
      return { statusCode: 200, ...MANIFEST };
    }

    let env0;
    try { env0 = isHttp ? JSON.parse(event.body || '{}') : (event || {}); } catch { return json(400, { error: 'bad json' }); }
    const runId = env0.runId || randomUUID();
    const mode = env0.mode || 'task';
    const task = env0.task || null;
    const chain = Array.isArray(env0.trace?.chain) ? env0.trace.chain : [];
    const parentRunId = env0.trace?.parentRunId || null;
    const onBehalfOf = env0.actor?.onBehalfOf || null;
    const respond = (status, body) => json(status, { runId, stop: true, ...body });
    if (!TASKS[task]) return respond(400, { status: 'error', error: `unknown task: ${task}` });
    if (!MODES.includes(mode)) return respond(400, { status: 'error', error: `bad mode: ${mode}` });

    // 1) Kill-switch FIRST, fail closed (SPEC-H 5). A calendar Cass builds feeds
    //    the Nico->Vera->Piper pipeline that ends in a publish, so on kill/pause
    //    OR unreachable controls Cass refuses to plan.
    let db;
    try { db = await getDb(); } catch {
      return respond(200, { status: 'refused', reply: 'controls unreachable - fail closed (controls_unreachable)' });
    }
    let states;
    try {
      const scopes = ['global', `agent:${AGENT}`, ...(onBehalfOf ? [`user:${onBehalfOf}`] : [])];
      states = new Set((await db.readControls(scopes) || []).map((r) => r.state));
    } catch {
      return respond(200, { status: 'refused', reply: 'controls unreachable - fail closed (controls_unreachable)' });
    }
    if (states.has('kill') || states.has('pause')) {
      try {
        await db.insertEvent({ agent: AGENT, event_type: 'kill_switch.engaged', person: onBehalfOf,
          payload: { runId, task, mode, enforced: true, states: [...states] } });
      } catch { /* audit best-effort */ }
      return respond(200, {
        status: states.has('kill') ? 'killed' : 'refused',
        reply: `HERALD ${states.has('kill') ? 'kill' : 'pause'} switch engaged - refusing (kill_enforced).`,
      });
    }

    // 2) App auth: Supabase JWT (dashboard) | scheduled system actor (EventBridge,
    //    already IAM-proven at the Function URL) | IAM-proven peer chain.
    let actor;
    const h = event.headers || {};
    const bearer = ((isHttp
      ? (h['x-supabase-auth'] || h['X-Supabase-Auth'] || h['x-cf-user-token'] || h['X-CF-User-Token'] || h.authorization || h.Authorization)
      : event.__userToken) || '').replace(/^Bearer\s+/i, '');
    if (bearer) {
      try { actor = await auth(bearer); }
      catch (e) { return respond(e.status === 403 ? 403 : 401, { status: 'refused', error: e.message }); }
    } else if (mode === 'scheduled') {
      actor = { type: 'system', userId: 'system:scheduler' };
    } else {
      const caller = chain[chain.length - 1];
      if (!caller || !ALLOWED_CALLERS.includes(caller)) {
        return respond(401, { status: 'refused', error: 'no user token and caller not in ALLOWED_CALLERS' });
      }
      actor = { type: 'agent', userId: `agent:${caller}`, caller };
    }

    // 3) Chain rules: depth <= 4, no cycles (SPEC-H 4).
    if (chain.length >= MAX_CHAIN_DEPTH) return respond(200, { status: 'refused', error: 'chain depth exceeded' });
    if (chain.includes(AGENT)) return respond(200, { status: 'refused', error: `chain cycle refused (${AGENT} already in chain)` });

    try {
      await db.insertRun({ id: runId, agent: AGENT, mode, task, parent_run_id: parentRunId, chain,
        actor_user_id: actor.userId, on_behalf_of: onBehalfOf, payload: env0.payload || {},
        status: 'running', started_at: nowFn() });
    } catch { /* observability, not a gate */ }

    let out;
    try {
      out = await TASKS[task]({ payload: env0.payload || {}, actor, runId, parentRunId, db, now: nowFn(), deps: taskDeps });
    } catch (e) { out = { status: 'error', error: e.message }; }
    const status = out.status || 'ok';

    let auditRef = null;
    try {
      await db.insertEvent({
        agent: AGENT, event_type: out.eventType || `cass.${task}.${status}`,
        subject_id: out.subjectId || null, person: out.person || onBehalfOf || null,
        payload: { runId, task, mode, status, actor: actor.userId, chain, error: out.error || null, ...(out.payloadOut || {}) },
        cost_usd: out.costCents != null ? out.costCents / 100 : null,
      });
      auditRef = `herald_events:run=${runId}`;
    } catch { /* best effort */ }
    try {
      await db.insertUsage({ service: SERVICE, month: nowFn().slice(0, 7),
        input_tokens: out.usage?.input_tokens || 0, output_tokens: out.usage?.output_tokens || 0,
        est_cost_cents: out.costCents || 0 });
    } catch { /* best effort */ }
    const runStatus = status === 'ok' ? 'ok'
      : (status === 'budget_exhausted' ? 'budget_exhausted'
        : (status === 'refused' ? 'refused' : (status === 'killed' ? 'killed' : 'error')));
    try {
      await db.patchRun(runId, { status: runStatus,
        result: { status, subjectId: out.subjectId || null, error: out.error || null }, finished_at: nowFn() });
    } catch { /* best effort */ }

    const httpStatus = status === 'ok' ? 200
      : (status === 'budget_exhausted' ? 402 : (status === 'refused' ? 403 : (status === 'error' ? 422 : 200)));
    return respond(httpStatus, {
      status, reply: out.reply || out.error || status,
      artifacts: out.artifacts || [], auditRef,
      usage: { inputTokens: out.usage?.input_tokens || 0, outputTokens: out.usage?.output_tokens || 0, costUsd: (out.costCents || 0) / 100 },
      error: out.error || null,
    });
  };
}

export const handler = createHandler();
