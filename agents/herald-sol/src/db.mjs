// Supabase REST access (service role, herald/sol/cf-service-key). Sol reads
// herald_fact_files (the entity source of truth) and WRITES herald_coverage
// snapshots (screen 05 reads the latest per person). Every material action emits
// a herald_events row (AGT-3). Sol never writes the content queue.
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
    getFactFile: async (personId) =>
      (await get(`herald_fact_files?person_id=eq.${encodeURIComponent(personId)}&select=person_id,data,version`))[0],
    listFactFiles: () => get('herald_fact_files?select=person_id,data,version&order=person_id.asc'),
    // Coverage snapshot upsert (idempotent on (snapshot_date, person)).
    upsertCoverage: (row) =>
      post('herald_coverage?on_conflict=snapshot_date,person', row, 'resolution=merge-duplicates,return=minimal'),
    // The most recent snapshot_date STRICTLY BEFORE `date` (for the weekly delta).
    priorCoverageDate: async (date) => {
      const rows = await get(`herald_coverage?snapshot_date=lt.${date}&select=snapshot_date&order=snapshot_date.desc&limit=1`);
      return rows[0]?.snapshot_date || null;
    },
  };
}
