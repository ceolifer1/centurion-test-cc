// Supabase REST access (service role, herald/vault/cf-service-key). The vault
// writes the append-only consent ledger + herald_events audit rows, and zeroes
// the capability grant on revoke (AGT-4). Cookie/session VALUES are NEVER written
// here (SPEC-C T3) - the ledger records who/what/when/scope, never the credential.
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
    // Consent ledger (SPEC-C 7). Append the PENDING row, patch state on capture/revoke.
    insertConsent: async (row) => (await post('herald_consent_ledger?select=id', row, 'return=representation'))[0],
    patchConsent: (id, row) => patch(`herald_consent_ledger?id=eq.${id}`, row),
    latestConsent: async (person, platform) =>
      (await get(`herald_consent_ledger?person=eq.${encodeURIComponent(person)}&platform=eq.${encodeURIComponent(platform)}&select=*&order=granted_at.desc&limit=1`))[0] || null,
    // Zero the platform capability grant on revoke (AGT-4). Reads current caps,
    // filters out the platform's herald.* strings, patches back. Best-effort.
    zeroGrant: async (userId, capStrings = []) => {
      if (!userId) return { zeroed: false, reason: 'no_user_id' };
      const rows = await get(`ecosystem_user_grants?user_id=eq.${encodeURIComponent(userId)}&select=capabilities`);
      const current = Array.isArray(rows[0]?.capabilities) ? rows[0].capabilities : [];
      const next = current.filter((c) => !capStrings.includes(c));
      if (next.length === current.length) return { zeroed: false, reason: 'no_matching_caps' };
      await patch(`ecosystem_user_grants?user_id=eq.${encodeURIComponent(userId)}`, { capabilities: next });
      return { zeroed: true, removed: current.length - next.length };
    },
  };
}
