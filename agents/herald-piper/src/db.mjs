// Supabase REST + RPC access (service role, herald/piper/cf-service-key). Every
// material action emits a herald_events row (AGT-3). The rate counters are
// reserved/committed/rolled-back through SECURITY DEFINER RPCs (migration 0003)
// so the check-and-increment is atomic - a crash can never undercount (SPEC-D
// 7.1 reserve-then-act). Cookie values are NEVER written here (SPEC-C T3).
import { CF_REST, secrets } from './config.mjs';

export async function makeDb(fetchImpl = fetch) {
  const s = await secrets();
  const key = s['cf-service-key'];
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const get = async (path) => {
    const r = await fetchImpl(`${CF_REST}/${path}`, { headers });
    if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
    return r.json();
  };
  const post = async (pathAndQuery, row, prefer = 'return=minimal') => {
    const r = await fetchImpl(`${CF_REST}/${pathAndQuery}`, {
      method: 'POST', headers: { ...headers, Prefer: prefer }, body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`POST ${pathAndQuery} -> ${r.status}`);
    return prefer.includes('representation') ? r.json() : null;
  };
  const patch = async (path, row) => {
    const r = await fetchImpl(`${CF_REST}/${path}`, { method: 'PATCH', headers, body: JSON.stringify(row) });
    if (!r.ok) throw new Error(`PATCH ${path} -> ${r.status}`);
  };
  const rpc = async (fn, args) => {
    const r = await fetchImpl(`${CF_REST}/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
    if (!r.ok) throw new Error(`RPC ${fn} -> ${r.status}`);
    return r.json();
  };
  return {
    readControls: (scopes) =>
      get(`herald_controls?scope=in.(${scopes.map((x) => `"${x}"`).map(encodeURIComponent).join(',')})&select=scope,state`),
    insertEvent: (row) => post('herald_events', row),
    insertRun: (row) => post('herald_runs', row),
    patchRun: (id, row) => patch(`herald_runs?id=eq.${id}`, row),
    getQueueItem: async (id) => (await get(`herald_content_queue?id=eq.${id}&select=*`))[0],
    patchQueueItem: (id, row) => patch(`herald_content_queue?id=eq.${id}`, row),
    // Rate counters (SPEC-D). reserve returns { allowed, reason?, window? }.
    reserveAction: (person, platform, actionClass, windows) =>
      rpc('herald_rate_reserve', { p_person: person, p_platform: platform, p_action_class: actionClass, p_windows: windows }),
    commitAction: (person, platform, actionClass, windows) =>
      rpc('herald_rate_commit', { p_person: person, p_platform: platform, p_action_class: actionClass, p_windows: windows }),
    rollbackAction: (person, platform, actionClass, windows) =>
      rpc('herald_rate_rollback', { p_person: person, p_platform: platform, p_action_class: actionClass, p_windows: windows }),
    lastActionAt: async (person, platform) => {
      const rows = await get(`herald_rate_counters?person=eq.${encodeURIComponent(person)}&platform=eq.${encodeURIComponent(platform)}&committed=gt.0&select=updated_at&order=updated_at.desc&limit=1`);
      return rows[0]?.updated_at || null;
    },
  };
}
