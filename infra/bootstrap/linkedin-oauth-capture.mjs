// HERALD LinkedIn OAuth capture - Ashton's ONE-TIME "Allow". Runs LOCALLY on the
// workstation. It (a) reads client_id/client_secret from 1P by exact item id
// (dodging the stale op:// cache), (b) starts localhost:8737, (c) prints the
// authorize URL for Ashton to open + Allow, (d) catches the redirect code,
// (e) exchanges code -> tokens, (f) fetches the author URN via /v2/userinfo,
// (g) writes the envelope into the deployed KMS-CMK vault secret. Tokens live in
// this process only - NEVER printed, NEVER written to disk (only handed to the
// aws CLI PutSecretValue child, same posture as the sibling seed scripts).
//
// Needs AWS creds -> run via the bootstrap credential runner:
//   node <ascend>/infra/bootstrap/run-with-aws.mjs -- node linkedin-oauth-capture.mjs [person]
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const lib = await import(new URL('../../agents/herald-linkedin/src/linkedin.mjs', import.meta.url));
const { exchangeCode, fetchAuthorUrn, tokenEnvelope } = lib;
const { client } = await import('file:///C:/Claude/.op-agent/op.mjs');

const AWS = 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe';
const REGION = 'us-east-1';
const VAULT_CIOS_PROD = '2k5hxvwrkdrkjk7e5nd2dlxkdq';
const PORT = 8737;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = process.env.LINKEDIN_SCOPE || 'openid profile w_member_social';
const person = (process.argv[2] || 'ashton-couture').trim();
const secretId = `herald/oauth/linkedin/${person}`;
const state = randomBytes(16).toString('hex');

// 1) client_id / client_secret from 1P (fresh, by item id resolved from title).
const c = await client();
const items = await c.items.list(VAULT_CIOS_PROD);
const hit = (items || []).find((i) => (i.title || '').toLowerCase() === 'linkedin-herald-app');
if (!hit) { console.error('ERROR: 1P item "linkedin-herald-app" not found in CIOS-prod. Create the app + item first.'); process.exit(1); }
const it = await c.items.get(VAULT_CIOS_PROD, hit.id);
const field = (t) => (it.fields || []).find((x) => (x.title || '').toLowerCase() === t)?.value || '';
const clientId = (field('client_id') || field('username')).trim();
const clientSecret = (field('client_secret') || field('credential')).trim();
if (!clientId || !clientSecret) { console.error('ERROR: linkedin-herald-app is missing client_id/client_secret fields.'); process.exit(1); }

function putSecret(value) {
  let r = spawnSync(AWS, ['secretsmanager', 'put-secret-value', '--secret-id', secretId, '--secret-string', value, '--region', REGION], { env: process.env, encoding: 'utf8' });
  if (r.status !== 0 && /ResourceNotFoundException/.test(r.stderr || '')) {
    r = spawnSync(AWS, ['secretsmanager', 'create-secret', '--name', secretId, '--secret-string', value, '--region', REGION], { env: process.env, encoding: 'utf8' });
  }
  return r;
}

const authUrl = 'https://www.linkedin.com/oauth/v2/authorization?' + new URLSearchParams({
  response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI, state, scope: SCOPE,
}).toString();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname !== '/callback') { res.writeHead(404); res.end('not found'); return; }
  const done = (code, msg) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(msg); };
  try {
    if (u.searchParams.get('error')) { done(400, `LinkedIn denied: ${u.searchParams.get('error')}`); console.error('DENIED:', u.searchParams.get('error')); server.close(); process.exit(1); }
    if (u.searchParams.get('state') !== state) { done(401, 'state mismatch - possible CSRF, aborted'); console.error('ERROR: state mismatch'); server.close(); process.exit(1); }
    const code = u.searchParams.get('code');
    if (!code) { done(400, 'no code'); return; }
    const raw = await exchangeCode({ code, clientId, clientSecret, redirectUri: REDIRECT_URI });
    const who = await fetchAuthorUrn({ accessToken: raw.access_token });
    const envelope = tokenEnvelope(raw, { authorUrn: who.authorUrn, scope: raw.scope || SCOPE });
    const r = putSecret(JSON.stringify(envelope));
    if (r.status !== 0) { done(500, 'vault write failed'); console.error('VAULT WRITE FAILED:', (r.stderr || '').slice(0, 200)); server.close(); process.exit(1); }
    done(200, `HERALD: LinkedIn token vaulted for ${person} (${who.name || who.authorUrn}). You can close this tab.`);
    console.log(`OK  vaulted ${secretId}  author=${who.authorUrn}  scope="${envelope.scope}"  expires_at=${envelope.expires_at}`);
    console.log('Token values were never printed. Capture complete.');
    server.close(); setTimeout(() => process.exit(0), 100);
  } catch (e) { done(500, 'capture error'); console.error('CAPTURE ERROR:', e.message); server.close(); process.exit(1); }
});

server.listen(PORT, () => {
  console.log(`\nHERALD LinkedIn OAuth capture for: ${person}`);
  console.log(`Vault target: ${secretId} (region ${REGION})`);
  console.log('\n1) Open this URL in a browser signed in as the target LinkedIn member:\n');
  console.log('   ' + authUrl + '\n');
  console.log('2) Click Allow. The localhost callback will capture + vault the token, then exit.');
  console.log('   (Listening on ' + REDIRECT_URI + ' - leave this running until it says "vaulted".)\n');
});
