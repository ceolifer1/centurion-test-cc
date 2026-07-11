// The ONE notification path (SPEC-G section 6): POST the composed report to the
// herald-notify CF edge function, which wraps CF's existing transactional email
// provider (no new vendor). Service-to-service auth uses the CF service-role key
// as bearer + apikey (the cf-deal-brain shared-secret pattern); herald-notify
// verifies it server-side. Injectable so unit tests never hit the network.
import { HERALD_NOTIFY_URL, secrets } from './config.mjs';

// Signature per SPEC-G section 6: { kind:'report'|'alert', to, subject, html }.
export async function sendNotify({ kind = 'report', to, subject, html }, fetchImpl = fetch) {
  const s = await secrets();
  const key = s['cf-service-key'];
  const r = await fetchImpl(HERALD_NOTIFY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: key, Authorization: `Bearer ${key}`, 'x-herald-service': 'rhea' },
    body: JSON.stringify({ kind, to, subject, html }),
  });
  if (!r.ok) {
    const b = await r.text().catch(() => '');
    throw new Error(`herald-notify ${r.status}: ${b.slice(0, 160)}`);
  }
  return r.json().catch(() => ({ ok: true }));
}
