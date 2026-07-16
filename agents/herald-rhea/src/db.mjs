// Supabase REST access (service role, herald/rhea/cf-service-key) for the CF-prod
// HERALD tables. Rhea READS the queue slice, the event stream, and the coverage
// snapshot for the window; it WRITES herald_reports (idempotent). Every material
// action emits a herald_events row (AGT-3).
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
    insertRun: (row) => post('herald_runs', row),
    patchRun: (id, row) => patch(`herald_runs?id=eq.${id}`, row),
    // Queue slice for the window (what posted / bounced / skipped / still needs you).
    queueInWindow: (startIso, endIso) =>
      get(`herald_content_queue?updated_at=gte.${startIso}&updated_at=lt.${endIso}&select=id,person,platform,kind,status,title,posted_at,external_ref,created_by,tier&order=updated_at.asc`),
    needsYouOpen: () =>
      get(`herald_content_queue?status=eq.vera_pass&tier=eq.crawl&select=id,person,platform,title&order=created_at.asc&limit=50`),
    // Event stream for the window (engagement snapshots, caps.*, follow suggestions).
    eventsInWindow: (startIso, endIso) =>
      get(`herald_events?at=gte.${startIso}&at=lt.${endIso}&select=at,agent,event_type,person,payload&order=at.asc&limit=2000`),
    // Coverage: the latest snapshot on/before the window end, plus its rows.
    coverageOnOrBefore: async (date) => {
      const d = await get(`herald_coverage?snapshot_date=lte.${date}&select=snapshot_date&order=snapshot_date.desc&limit=1`);
      const snap = d[0]?.snapshot_date || null;
      if (!snap) return { date: null, rows: [] };
      const rows = await get(`herald_coverage?snapshot_date=eq.${snap}&select=person,score,present,total,gaps`);
      return { date: snap, rows };
    },
    // Prior report of this type for the delta baseline (period ends before this one).
    priorReport: async (type, periodStartIso) => {
      const rows = await get(`herald_reports?type=eq.${type}&period_end=lt.${periodStartIso.slice(0, 10)}&select=metrics,period_start,period_end&order=period_end.desc&limit=1`);
      return rows[0] || null;
    },
    // Idempotent report upsert (unique on type,period_start,period_end).
    upsertReport: async (row) =>
      (await post('herald_reports?on_conflict=type,period_start,period_end&select=id', row, 'resolution=merge-duplicates,return=representation'))[0],
    markReportSent: (id, sentTo, sentAt) =>
      patch(`herald_reports?id=eq.${id}`, { sent_to: sentTo, sent_at: sentAt }),
  };
}
