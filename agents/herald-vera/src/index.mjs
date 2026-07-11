// herald-vera Lambda handler (Function URL, AWS_IAM transport auth).
// Routes:
//   GET  /manifest -> AGT-2 manifest (SPEC-B 7.1 superset)
//   POST /invoke   -> SPEC-B 7.2 envelope { runId, mode, task, actor, payload,
//                     trace.chain } -> { runId, status, verdict, artifacts,
//                     auditRef, usage, stop }
// Handler order on EVERY invoke (SPEC-B 7.2 + Stage-1 brief): parse ->
// kill-switch check FIRST (fail closed; except the kill_switch task itself) ->
// app auth (Supabase JWT for dashboard, IAM-proven chain for peers) -> chain
// rules -> task -> herald_events + agent_usage rows (AGT-3).
import { randomUUID } from 'node:crypto';
import { authorize } from './auth.mjs';
import { makeDb } from './db.mjs';
import { reviewContent, watchLive, killSwitch } from './tasks.mjs';
import { ALLOWED_CALLERS, MAX_CHAIN_DEPTH, SERVICE, LLM_BRAND_PASS } from './config.mjs';
import { RULESET_VERSION } from './rules.mjs';

export const MANIFEST = {
  service: 'herald-vera',
  agent: 'vera',
  engine: 'herald',
  version: '1.0.0',
  capabilities: ['review_content', 'watch_live', 'kill_switch'],
  models: { default: 'claude-sonnet-5', escalation: 'claude-opus-4-8' },
  cost_class: 'medium',
  ruleset_version: RULESET_VERSION,
  deterministic_only: !LLM_BRAND_PASS,
  auth: { transport: 'aws_iam_function_url', app: 'supabase_jwt+ecosystem_user_grants' },
  invoke: {
    method: 'POST', path: '/invoke',
    envelope: {
      runId: 'uuid', mode: 'chat|task|scheduled|watch|dry_run', task: 'string?',
      sessionId: 'uuid?', actor: { userId: 'uuid', onBehalfOf: 'uuid?' },
      payload: 'object', trace: { chain: 'string[]', parentRunId: 'uuid?' },
    },
  },
  variant: 'lambda',
  kill_switch_scopes: ['global', 'agent', 'user'],
  owner: 'centurionfinancial.com',
};

const TASKS = { review_content: reviewContent, watch_live: watchLive, kill_switch: killSwitch };
const MODES = ['chat', 'task', 'scheduled', 'watch', 'dry_run'];

export function createHandler(deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const auth = deps.authorize || ((b) => authorize(b, fetchImpl));
  const getDb = deps.makeDb || (() => makeDb(fetchImpl));
  const nowFn = deps.now || (() => new Date().toISOString());

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
    const task = env0.task || (mode === 'watch' ? 'watch_live' : null);
    const chain = Array.isArray(env0.trace?.chain) ? env0.trace.chain : [];
    const onBehalfOf = env0.actor?.onBehalfOf || null;
    const respond = (status, body) => json(status, { runId, stop: true, ...body });
    if (!TASKS[task]) return respond(400, { status: 'error', error: `unknown task: ${task}` });
    if (!MODES.includes(mode)) return respond(400, { status: 'error', error: `bad mode: ${mode}` });

    // 1) Kill-switch check FIRST, fail closed (SPEC-H section 5). The
    //    kill_switch task itself skips the gate - it must work mid-incident.
    let db;
    try { db = await getDb(); } catch {
      return respond(200, { status: task === 'kill_switch' ? 'error' : 'refused', reply: 'controls unreachable - fail closed (controls_unreachable)' });
    }
    if (task !== 'kill_switch') {
      let states;
      try {
        const scopes = ['global', 'agent:vera', ...(onBehalfOf ? [`user:${onBehalfOf}`] : [])];
        states = new Set((await db.readControls(scopes) || []).map((r) => r.state));
      } catch {
        return respond(200, { status: 'refused', reply: 'controls unreachable - fail closed (controls_unreachable)' });
      }
      if (states.has('kill') || states.has('pause')) {
        try {
          await db.insertEvent({ agent: 'vera', event_type: 'kill_enforced', person: onBehalfOf,
            payload: { runId, task, mode, states: [...states] } });
        } catch { /* audit best-effort on refusal path */ }
        return respond(200, {
          status: states.has('kill') ? 'killed' : 'refused',
          reply: `HERALD ${states.has('kill') ? 'kill' : 'pause'} switch engaged - refusing (kill_enforced).`,
        });
      }
    }

    // 2) App auth: Supabase JWT (dashboard origin) or IAM-proven peer chain.
    //    Peer calls carry NO JWT - the caller is the last chain element,
    //    cross-checked against ALLOWED_CALLERS (SPEC-B 7.2 rule 3 / SPEC-H 4.4).
    let actor;
    const h = event.headers || {};
    const bearer = ((isHttp
      ? (h['x-supabase-auth'] || h['X-Supabase-Auth'] || h['x-cf-user-token'] || h['X-CF-User-Token'] || h.authorization || h.Authorization)
      : event.__userToken) || '').replace(/^Bearer\s+/i, '');
    if (bearer) {
      try { actor = await auth(bearer); }
      catch (e) { return respond(e.status === 403 ? 403 : 401, { status: 'refused', error: e.message }); }
    } else {
      const caller = chain[chain.length - 1];
      if (!caller || !ALLOWED_CALLERS.includes(caller)) {
        return respond(401, { status: 'refused', error: 'no user token and caller not in ALLOWED_CALLERS' });
      }
      actor = { type: 'agent', userId: `agent:${caller}`, caller };
    }

    // 3) Chain rules: depth <= 4, no cycles (SPEC-H section 4).
    if (chain.length >= MAX_CHAIN_DEPTH) return respond(200, { status: 'refused', error: 'chain depth exceeded' });
    if (chain.includes('vera')) return respond(200, { status: 'refused', error: 'chain cycle refused (vera already in chain)' });

    // Own herald_runs row per hop (SPEC-H 3.1) - best effort.
    try {
      await db.insertRun({ id: runId, agent: 'vera', mode, task,
        parent_run_id: env0.trace?.parentRunId || null, chain,
        actor_user_id: actor.userId, on_behalf_of: onBehalfOf,
        payload: env0.payload || {}, status: 'running', started_at: nowFn() });
    } catch { /* runs row is observability, not a gate */ }

    let out;
    try { out = await TASKS[task]({ payload: env0.payload || {}, actor, db, now: nowFn() }); }
    catch (e) { out = { status: 'error', error: e.message }; }
    const status = out.status || 'ok';

    // 4) AGT-3: every invoke writes an audit event + a usage-ledger row.
    //    Deterministic P1 = zero tokens, zero cost, but the invoke is recorded.
    let auditRef = null;
    try {
      await db.insertEvent({
        agent: 'vera',
        event_type: out.eventType || `vera.${task}.${status}`,
        subject_id: out.subjectId || null,
        person: out.person || onBehalfOf || null,
        payload: { runId, task, mode, status, verdict: out.verdict ?? null,
          rule_ids: out.bounce?.rule_ids || [], actor: actor.userId, chain,
          error: out.error || null, ...(out.payloadOut || {}) },
      });
      auditRef = `herald_events:run=${runId}`;
    } catch { /* best effort - Vera does not publish, so no publish-block path */ }
    try {
      await db.insertUsage({ service: SERVICE, month: nowFn().slice(0, 7),
        input_tokens: 0, output_tokens: 0, est_cost_cents: 0 });
    } catch { /* ledger row is best effort for zero-cost deterministic turns */ }
    try {
      await db.patchRun(runId, {
        status: status === 'ok' ? 'ok' : (status === 'refused' ? 'refused' : 'error'),
        result: { status, verdict: out.verdict ?? null, error: out.error || null },
        finished_at: nowFn(),
      });
    } catch { /* best effort */ }

    return respond(status === 'error' ? 422 : (status === 'refused' ? 403 : 200), {
      status,
      verdict: out.verdict ?? null,
      reply: out.reply || out.error || status,
      artifacts: out.bounce
        ? [{ type: 'vera_verdict', ref: out.subjectId ? `herald_content_queue:${out.subjectId}` : null, data: out.bounce }]
        : [],
      auditRef,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      error: out.error || null,
    });
  };
}

export const handler = createHandler();
