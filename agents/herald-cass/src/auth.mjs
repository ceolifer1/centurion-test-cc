// App-level auth for dashboard-origin calls (cf-mandate-ops pattern, duplicated
// per SEC-3). Verify the Supabase user token via GET /auth/v1/user (CF is legacy
// HS256, JWKS empty - no local JWT verify), then gate on the 'herald' capability
// in ecosystem_user_grants. Peer/scheduled calls carry NO JWT - their identity
// is proven by AWS_IAM on the Function URL (ALLOWED_CALLERS / mode='scheduled'
// handled in the handler, SPEC-B 7.2).
import { CF_AUTH, CF_REST, CAPABILITY, secrets } from './config.mjs';

const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };

export async function authorize(bearer, fetchImpl = fetch) {
  if (!bearer) fail(401, 'missing bearer token');
  const s = await secrets();
  const ur = await fetchImpl(`${CF_AUTH}/user`, {
    headers: { apikey: s['cf-anon-key'], Authorization: `Bearer ${bearer}` },
  });
  if (!ur.ok) fail(401, 'invalid session');
  const user = await ur.json();
  if (!user?.id) fail(401, 'no user in token');
  const gr = await fetchImpl(
    `${CF_REST}/ecosystem_user_grants?user_id=eq.${user.id}&select=is_active,role,capabilities`,
    { headers: { apikey: s['cf-service-key'], Authorization: `Bearer ${s['cf-service-key']}` } },
  );
  if (!gr.ok) fail(500, 'grant lookup failed');
  const g = (await gr.json())[0];
  const caps = Array.isArray(g?.capabilities) ? g.capabilities : [];
  if (!g || !g.is_active || !caps.includes(CAPABILITY)) fail(403, `${CAPABILITY} capability required`);
  return { type: 'user', userId: user.id, email: user.email, role: g.role };
}
