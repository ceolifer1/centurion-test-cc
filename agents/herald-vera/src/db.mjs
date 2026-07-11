// Supabase REST access (service role, herald/vera/cf-service-key). Writes are
// the agent's audit duty: every material action emits a herald_events row
// (AGT-3 - the audit trail IS the conversation).
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
    return null;
  };
  const patch = async (path, row) => {
    const r = await fetchImpl(`${CF_REST}/${path}`, { method: 'PATCH', headers, body: JSON.stringify(row) });
    if (!r.ok) throw new Error(`PATCH ${path} -> ${r.status}`);
  };
  return {
    readControls: (scopes) =>
      get(`herald_controls?scope=in.(${scopes.map((x) => `"${x}"`).map(encodeURIComponent).join(',')})&select=scope,state`),
    upsertControl: (row) => post('herald_controls?on_conflict=scope', row, 'resolution=merge-duplicates'),
    insertEvent: (row) => post('herald_events', row),
    insertUsage: (row) => post('agent_usage', row),
    insertRun: (row) => post('herald_runs', row),
    patchRun: (id, row) => patch(`herald_runs?id=eq.${id}`, row),
    getQueueItem: async (id) => (await get(`herald_content_queue?id=eq.${id}&select=*`))[0],
    patchQueueItem: (id, row) => patch(`herald_content_queue?id=eq.${id}`, row),
    getFactFile: async (personId) =>
      (await get(`herald_fact_files?person_id=eq.${encodeURIComponent(personId)}&select=person_id,data,version`))[0],
    listFactFiles: () => get('herald_fact_files?select=person_id,data,version'),
  };
}
