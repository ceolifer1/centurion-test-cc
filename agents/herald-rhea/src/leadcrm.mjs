// SPEC-F Option A pipeline read from leadcrm-prod (xnmixbspbuqyyhkrskwc), with
// Rhea's own service key (herald/rhea/leadcrm-key). This is the same REST read
// path cf-mandate-ops / deal-brain use; we embed pipeline_stages + pipelines and
// apply the Option A basis in JS (Enterprise -> lending_amount, Funding ->
// amount; all open, non-won/lost). Injectable so unit tests never hit the network.
// Framing rule (SPEC-F 3): "current active pipeline", NEVER "AUM"/"raised".
import { LEADCRM_REST, PIPELINE_BASIS, secrets } from './config.mjs';

// Round DOWN to a defensible display band (SPEC-F 3): the raw figure never
// publishes. e.g. 4_750_000_000 -> "$4.7B+".
export function displayBand(value) {
  const v = Number(value || 0);
  if (v >= 1e9) return `$${Math.floor(v / 1e8) / 10}B+`;
  if (v >= 1e6) return `$${Math.floor(v / 1e5) / 10}M+`;
  if (v >= 1e3) return `$${Math.floor(v / 1e2) / 10}K+`;
  return `$${Math.floor(v)}`;
}

// Sum Option A over an array of deal rows shaped like the embedded select below.
export function sumOptionA(deals) {
  let value = 0; let count = 0;
  for (const d of deals || []) {
    const stage = d.pipeline_stages || d.stage || null;
    if (!stage || stage.is_won || stage.is_lost) continue;
    const name = stage.pipelines?.name || stage.pipeline?.name || null;
    const basis = PIPELINE_BASIS[name];
    if (!basis) continue; // pipelines outside Enterprise/Funding do not count (Option A basis)
    value += Number(d[basis] || 0);
    count += 1;
  }
  return { value, deal_count: count };
}

export async function readPipelineValue({ fetchImpl = fetch } = {}) {
  const s = await secrets();
  const key = s['leadcrm-key'];
  if (!key) throw new Error('leadcrm-key not configured');
  const select = 'lending_amount,amount,pipeline_stages!inner(is_won,is_lost,pipelines!inner(name))';
  const url = `${LEADCRM_REST}/deals?status=eq.open`
    + `&pipeline_stages.is_won=eq.false&pipeline_stages.is_lost=eq.false`
    + `&select=${encodeURIComponent(select)}&limit=5000`;
  const r = await fetchImpl(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`leadcrm deals read -> ${r.status}`);
  const deals = await r.json();
  const { value, deal_count } = sumOptionA(deals);
  return {
    value, deal_count, currency: 'USD',
    basis: 'capital-sought (SPEC-F Option A: Enterprise lending_amount + Funding amount, open non-won/lost)',
    display: displayBand(value),
    framing: 'current active pipeline', // never AUM / raised
  };
}
