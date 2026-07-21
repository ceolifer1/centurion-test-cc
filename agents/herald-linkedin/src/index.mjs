// herald-linkedin Lambda handler (Function URL, AWS_IAM transport auth).
// Routes:
//   GET  /manifest -> AGT-2 manifest
//   POST /invoke   -> SPEC-B 7.2 envelope -> 7.3 response
// Invokers: the EventBridge schedule (direct, mode='scheduled' -> publish_due /
// refresh_tokens), a future LINDA/dashboard "post now" (HTTP + Supabase JWT), or
// a peer agent (IAM + ALLOWED_CALLERS). Handler order on EVERY invoke: parse ->
// kill-switch check FIRST (fail-closed) -> app/transport auth -> chain rules ->
// task -> herald_events + herald_runs (AGT-3). The publisher makes ZERO real
// LinkedIn calls unless HERALD_LIVE=true (dry-run default).
import { randomUUID } from 'node:crypto';
import { authorize } from './auth.mjs';
import { makeDb } from './db.mjs';
import { publishItem, publishDue, refreshTokens } from './publish.mjs';
import {
  ALLOWED_CALLERS, MAX_CHAIN_DEPTH, AGENT, HERALD_LIVE, LINKEDIN_VERSION, ORG_ENABLED,
} from './config.mjs';

export const MANIFEST = {
  service: 'herald-linkedin',
  agent: 'linkedin',
  engine: 'herald',
  version: '1.0.0',
  capabilities: ['publish', 'publish_due', 'refresh_tokens'],
  transport_to_linkedin: 'official_rest_api',
  api: { endpoint: 'POST https://api.linkedin.com/rest/posts', version_header: LINKEDIN_VERSION, scope: 'w_member_social', author_urn: 'urn:li:person:{sub} via /v2/userinfo' },
  models: {},
  cost_class: 'low',
  dry_run_default: !HERALD_LIVE,
  org_page_enabled: ORG_ENABLED,
  auth: { transport: 'aws_iam_function_url', app: 'supabase_jwt+ecosystem_user_grants | scheduler_iam' },
  invoke: {
    method: 'POST', path: '/invoke',
    envelope: { runId: 'uuid', mode: 'task|scheduled|dry_run', task: 'publish|publish_due|refresh_tokens', payload: 'object', trace: { chain: 'string[]' } },
  },
  variant: 'lambda',
  kill_switch_scopes: ['global', 'agent', 'user'],
  owner: 'centurionfinancial.com',
};

const MODES = ['chat', 'task', 'scheduled', 'watch', 'dry_run'];
const SYSTEM_MODES = new Set(['scheduled', 'dry_run', 'watch']);

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
    const TASKS = new Set(['publish', 'publish_due', 'refresh_tokens']);
    if (!TASKS.has(task)) return respond(400, { status: 'error', error: `unknown task: ${task}` });
    if (!MODES.includes(mode)) return respond(400, { status: 'error', error: `bad mode: ${mode}` });

    // 1) Kill-switch FIRST, fail closed (SPEC-H 5). Everything this agent does
    //    leads to a publish, so on kill/pause OR unreachable controls it refuses.
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
      } catch { /* audit best-effort on refusal path */ }
      return respond(200, {
        status: states.has('kill') ? 'killed' : 'refused',
        reply: `HERALD ${states.has('kill') ? 'kill' : 'pause'} switch engaged - refusing (kill_enforced).`,
      });
    }

    // 2) Auth: Supabase JWT (dashboard "post now"), IAM-proven peer chain, or a
    //    scheduled/system invoke (transport-authed by the scheduler role's IAM).
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
      if (caller && ALLOWED_CALLERS.includes(caller)) {
        actor = { type: 'agent', userId: `agent:${caller}`, caller };
      } else if (!isHttp && SYSTEM_MODES.has(mode)) {
        actor = { type: 'system', userId: 'system:herald-schedule' };
      } else {
        return respond(401, { status: 'refused', error: 'no user token, caller not allowed, and not a scheduled system invoke' });
      }
    }

    // 3) Chain rules: depth <= 4, no cycles (SPEC-H 4).
    if (chain.length >= MAX_CHAIN_DEPTH) return respond(200, { status: 'refused', error: 'chain depth exceeded' });
    if (chain.includes(AGENT)) return respond(200, { status: 'refused', error: `chain cycle refused (${AGENT} already in chain)` });

    // Own herald_runs row per hop (best effort).
    try {
      await db.insertRun({ id: runId, agent: AGENT, mode, task, parent_run_id: parentRunId, chain,
        actor_user_id: actor.userId, on_behalf_of: onBehalfOf, payload: env0.payload || {},
        status: 'running', started_at: nowFn() });
    } catch { /* observability, not a gate */ }

    let out;
    try {
      if (task === 'publish') {
        const itemId = env0.payload?.item_id || env0.payload?.itemId;
        if (!itemId) out = { status: 'error', reason: 'payload.item_id required' };
        else {
          const item = await db.getQueueItem(itemId);
          if (!item) out = { status: 'error', reason: `queue item ${itemId} not found` };
          else out = await publishItem({ db, item, runId, deps: taskDeps });
        }
      } else if (task === 'publish_due') {
        out = await publishDue({ db, runId, deps: taskDeps });
      } else {
        out = await refreshTokens({ db, runId, deps: taskDeps });
      }
    } catch (e) { out = { status: 'error', reason: e.message }; }
    const status = out.status || 'ok';

    // 4) AGT-3 audit event + run patch.
    let auditRef = null;
    try {
      await db.insertEvent({
        agent: AGENT, event_type: `linkedin.${task}.${status}`,
        subject_id: env0.payload?.item_id || null, person: onBehalfOf || null,
        payload: { runId, task, mode, status, actor: actor.userId, chain, live: HERALD_LIVE,
          reason: out.reason || null, external_ref: out.externalRef || null, dry_run: out.dryRun ?? null,
          results: out.results || null, swept: out.swept ?? null },
      });
      auditRef = `herald_events:run=${runId}`;
    } catch { /* best effort */ }

    const httpStatus = status === 'ok' ? 200
      : (status === 'refused' || status === 'killed' ? 403 : (status === 'error' ? 422 : 200));
    return respond(httpStatus, {
      status,
      reply: out.reply || out.reason || status,
      dryRun: out.dryRun ?? null,
      artifacts: out.externalRef ? [{ type: out.dryRun ? 'would_post' : 'linkedin_post', ref: out.externalRef }] : [],
      auditRef,
      error: status === 'error' ? (out.reason || 'error') : null,
    });
  };
}

export const handler = createHandler();
