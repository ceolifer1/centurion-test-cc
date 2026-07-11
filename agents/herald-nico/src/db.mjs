// Supabase REST access (service role, herald/nico/cf-service-key). Writes are
// the agent's audit duty: every material action emits a herald_events row
// (AGT-3 - the audit trail IS the conversation). Nico is the AUTHOR of
// herald_content_queue rows (SPEC-G section 2); Vera only writes vera_verdict
// when handed a contentId - Nico hands content inline and owns the row.
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
  return {
    readControls: (scopes) =>
      get(`herald_controls?scope=in.(${scopes.map((x) => `"${x}"`).map(encodeURIComponent).join(',')})&select=scope,state`),
    insertEvent: (row) => post('herald_events', row),
    insertUsage: (row) => post('agent_usage', row),
    insertRun: (row) => post('herald_runs', row),
    patchRun: (id, row) => patch(`herald_runs?id=eq.${id}`, row),
    // Content queue: Nico authors rows and reads bounces for the redraft loop.
    insertQueueItem: async (row) => (await post('herald_content_queue?select=id', row, 'return=representation'))[0],
    getQueueItem: async (id) => (await get(`herald_content_queue?id=eq.${id}&select=*`))[0],
    patchQueueItem: (id, row) => patch(`herald_content_queue?id=eq.${id}`, row),
    listBounced: (limit = 5) =>
      get(`herald_content_queue?status=eq.bounced&select=*&order=created_at.asc&limit=${limit}`),
    getFactFile: async (personId) =>
      (await get(`herald_fact_files?person_id=eq.${encodeURIComponent(personId)}&select=person_id,data,version`))[0],
    // Engine-wide month-to-date spend in cents across ALL herald-* services
    // (SPEC-B 6A hard stop). PostgREST returns the rows; we sum client-side.
    monthSpendCents: async (month) => {
      const rows = await get(`agent_usage?service=like.herald-%25&month=eq.${month}&select=est_cost_cents`);
      return rows.reduce((a, r) => a + (Number(r.est_cost_cents) || 0), 0);
    },
  };
}
