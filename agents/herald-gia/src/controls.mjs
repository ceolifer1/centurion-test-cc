// Kill-switch check (SPEC-H section 5), fail-closed. Read global + agent:gia +
// user:<person>; most restrictive wins (kill > pause > run). In-memory cache,
// 60s max TTL (5.2) - no cached 'run' older than 60s authorizes an action. If CF
// prod is unreachable the checker returns action 'refuse' (5.4): the run may do
// read-only work but MUST NOT engage. Token material is never read here. Exact
// peer of agents/herald-linkedin/src/controls.mjs (AGENT resolves to 'gia').
import { KILL_CACHE_TTL_MS, AGENT } from './config.mjs';

function decide(states) {
  if (states.has('kill')) return { ok: false, action: 'kill', reason: 'kill' };
  if (states.has('pause')) return { ok: false, action: 'pause', reason: 'pause' };
  return { ok: true, action: 'run' };
}

export function makeKillChecker(db, { ttlMs = KILL_CACHE_TTL_MS, now = () => Date.now() } = {}) {
  let cache = null;
  return async function check(onBehalfOf = null) {
    const t = now();
    if (cache && cache.key === onBehalfOf && (t - cache.at) < ttlMs) return decide(cache.states);
    const scopes = ['global', `agent:${AGENT}`, ...(onBehalfOf ? [`user:${onBehalfOf}`] : [])];
    let rows;
    try { rows = await db.readControls(scopes); }
    catch { return { ok: false, action: 'refuse', reason: 'controls_unreachable' }; }
    const states = new Set((rows || []).map((r) => r.state));
    cache = { at: t, key: onBehalfOf, states };
    return decide(states);
  };
}
