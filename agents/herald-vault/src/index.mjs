// herald-vault Lambda handler (Function URL, AWS_IAM transport auth). SPEC-C.
// Routes: GET /manifest -> AGT-2 manifest; POST /invoke -> SPEC-B 7.2 envelope.
// Handler order: parse -> kill-switch check FIRST (fail closed) EXCEPT
// revoke_session + session_status, which MUST work mid-incident (a revoke is a
// security control, like Vera's kill_switch) -> app auth (Supabase JWT; consent
// + revoke are dashboard-driven, no peer caller) -> task -> herald_events +
// herald_runs + agent_usage (AGT-3). The Lambda NEVER touches cookie plaintext.
import { randomUUID } from 'node:crypto';
import { authorize } from './auth.mjs';
import { makeDb } from './db.mjs';
import { initiateConsent, markActive, revokeSession, sessionStatus } from './tasks.mjs';
import { ALLOWED_CALLERS, MAX_CHAIN_DEPTH, SERVICE, AGENT } from './config.mjs';

export const MANIFEST = {
  service: 'herald-vault',
  agent: 'vault',
  engine: 'herald',
  version: '1.0.0',
  capabilities: ['initiate_consent', 'mark_active', 'revoke_session', 'session_status'],
  models: {},
  cost_class: 'low',
  deterministic_only: true,
  auth: { transport: 'aws_iam_function_url', app: 'supabase_jwt+ecosystem_user_grants' },
  invoke: {
    method: 'POST', path: '/invoke',
    envelope: {
      runId: 'uuid', mode: 'chat|task|scheduled|watch|dry_run', task: 'string?',
      actor: { userId: 'uuid', onBehalfOf: 'uuid?' }, payload: 'object', trace: { chain: 'string[]', parentRunId: 'uuid?' },
    },
  },
  variant: 'lambda',
  kill_switch_scopes: ['global', 'agent', 'user'],
  owner: 'centurionfinancial.com',
};

const TASKS = { initiate_consent: initiateConsent, mark_active: markActive, revoke_session: revokeSession, session_status: sessionStatus };
// Security controls that must run even when the engine is killed/paused (SPEC-C 6).
const KILL_EXEMPT = new Set(['revoke_session', 'session_status']);
const MODES = ['chat', 'task', 'scheduled', 'watch', 'dry_run'];

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
    const onBehalfOf = env0.actor?.onBehalfOf || env0.payload?.person || null;
    const respond = (status, body) => json(status, { runId, stop: true, ...body });
    if (!TASKS[task]) return respond(400, { status: 'error', error: `unknown task: ${task}` });
    if (!MODES.includes(mode)) return respond(400, { status: 'error', error: `bad mode: ${mode}` });

    // 1) Kill-switch FIRST, fail closed - EXCEPT revoke/status (must work mid-incident).
    let db;
    try { db = await getDb(); } catch {
      return respond(200, { status: KILL_EXEMPT.has(task) ? 'error' : 'refused', reply: 'controls unreachable - fail closed (controls_unreachable)' });
    }
    if (!KILL_EXEMPT.has(task)) {
      let states;
      try {
        const scopes = ['global', `agent:${AGENT}`, ...(onBehalfOf ? [`user:${onBehalfOf}`] : [])];
        states = new Set((await db.readControls(scopes) || []).map((r) => r.state));
      } catch {
        return respond(200, { status: 'refused', reply: 'controls unreachable - fail closed (controls_unreachable)' });
      }
      if (states.has('kill') || states.has('pause')) {
        await db.insertEvent({ agent: AGENT, event_type: 'kill_switch.engaged', person: onBehalfOf,
          payload: { runId, task, mode, enforced: true, states: [...states] } }).catch(() => {});
        return respond(200, { status: states.has('kill') ? 'killed' : 'refused',
          reply: `HERALD ${states.has('kill') ? 'kill' : 'pause'} switch engaged - refusing (kill_enforced).` });
      }
    }

    // 2) App auth: Supabase JWT (dashboard). No peer invokes the vault.
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
        return respond(401, { status: 'refused', error: 'no user token and caller not permitted' });
      }
      actor = { type: 'agent', userId: `agent:${caller}`, caller };
    }

    if (chain.length >= MAX_CHAIN_DEPTH) return respond(200, { status: 'refused', error: 'chain depth exceeded' });

    try {
      await db.insertRun({ id: runId, agent: AGENT, mode, task, parent_run_id: parentRunId, chain,
        actor_user_id: actor.userId, on_behalf_of: onBehalfOf, payload: { person: env0.payload?.person, platform: env0.payload?.platform },
        status: 'running', started_at: nowFn() });
    } catch { /* observability, not a gate */ }

    let out;
    try { out = await TASKS[task]({ payload: env0.payload || {}, actor, runId, parentRunId, db, now: nowFn(), deps: taskDeps }); }
    catch (e) { out = { status: 'error', error: e.message }; }
    const status = out.status || 'ok';

    let auditRef = null;
    try {
      await db.insertEvent({ agent: AGENT, event_type: out.eventType || `vault.${task}.${status}`,
        subject_id: out.subjectId || null, person: out.person || onBehalfOf || null,
        payload: { runId, task, mode, status, actor: actor.userId, error: out.error || null, ...(out.payloadOut || {}) } });
      auditRef = `herald_events:run=${runId}`;
    } catch { /* best effort */ }
    try { await db.insertUsage({ service: SERVICE, month: nowFn().slice(0, 7), input_tokens: 0, output_tokens: 0, est_cost_cents: 0 }); } catch { /* best effort */ }
    try {
      await db.patchRun(runId, { status: status === 'ok' ? 'ok' : (status === 'refused' ? 'refused' : (status === 'killed' ? 'killed' : 'error')),
        result: { status, error: out.error || null }, finished_at: nowFn() });
    } catch { /* best effort */ }

    return respond(status === 'ok' ? 200 : (status === 'refused' ? 403 : (status === 'error' ? 422 : 200)), {
      status, reply: out.reply || out.error || status,
      artifacts: out.subjectId ? [{ type: 'consent_ledger', ref: `herald_consent_ledger:${out.subjectId}`, data: out.payloadOut || null }] : [],
      auditRef, error: out.error || null,
    });
  };
}

export const handler = createHandler();
