// Seeds herald/linkedin/* Secrets Manager values (the TF-created placeholders).
// Values flow 1Password -> Secrets Manager IN PROCESS - never printed, never on
// disk, never in model context. Idempotent. Sibling of seed-herald-agent-secrets.mjs.
//
//   herald/linkedin/cf-service-key  <- op://CIOS-prod/cf-service-role/credential
//   herald/linkedin/cf-anon-key     <- op://Centurion-Financial-prod/supabase/publishable_key
//   herald/linkedin/client-id       <- op://CIOS-prod/linkedin-herald-app (field client_id)
//   herald/linkedin/client-secret   <- op://CIOS-prod/linkedin-herald-app (field client_secret)
//
// The LinkedIn app + its 1P item DO NOT EXIST until Ashton creates the app, so
// client-id/client-secret are SKIPPED cleanly until then. Re-run this once the
// 1P item exists to populate them (needed for token refresh_tokens()).
// Usage: node <ascend>/infra/bootstrap/run-with-aws.mjs -- node seed-linkedin-secrets.mjs
import { spawnSync } from 'node:child_process';
const op = await import('file:///C:/Claude/.op-agent/op.mjs');
const { resolve, client } = op;

const AWS = 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe';
const region = 'us-east-1';
const VAULT_CIOS_PROD = '2k5hxvwrkdrkjk7e5nd2dlxkdq';

function aws(args) { return spawnSync(AWS, args.concat(['--region', region]), { env: process.env, encoding: 'utf8' }); }
function put(name, value) {
  if (!value || value.length < 5) { console.log(`SKIP ${name} (empty source)`); return; }
  let r = aws(['secretsmanager', 'put-secret-value', '--secret-id', name, '--secret-string', value]);
  if (r.status !== 0 && /ResourceNotFoundException/.test(r.stderr || '')) {
    r = aws(['secretsmanager', 'create-secret', '--name', name, '--secret-string', value,
      '--tags', 'Key=project,Value=cios', 'Key=engine,Value=herald', 'Key=managed_by,Value=seeder']);
  }
  console.log(r.status === 0 ? `OK   ${name} (len ${value.length})` : `FAIL ${name}: ${(r.stderr || '').slice(0, 160)}`);
}

// CF keys (exist today).
const cfService = (await resolve('op://CIOS-prod/cf-service-role/credential')).trim();
const cfAnon = (await resolve('op://Centurion-Financial-prod/supabase/publishable_key')).trim();
put('herald/linkedin/cf-service-key', cfService);
put('herald/linkedin/cf-anon-key', cfAnon);

// LinkedIn app credentials - read by EXACT item id (dodge the stale op:// cache),
// resolved by title so we do not need to hardcode an id that does not exist yet.
try {
  const c = await client();
  const items = await c.items.list(VAULT_CIOS_PROD);
  const hit = (items || []).find((i) => (i.title || '').toLowerCase() === 'linkedin-herald-app');
  if (!hit) { console.log('SKIP herald/linkedin/client-id + client-secret (1P item linkedin-herald-app not found yet)'); }
  else {
    const it = await c.items.get(VAULT_CIOS_PROD, hit.id);
    const f = (t) => (it.fields || []).find((x) => (x.title || '').toLowerCase() === t)?.value || '';
    put('herald/linkedin/client-id', (f('client_id') || f('username')).trim());
    put('herald/linkedin/client-secret', (f('client_secret') || f('credential')).trim());
  }
} catch (e) { console.log('SKIP linkedin app creds (1P read failed): ' + e.message); }
console.log('== seed-linkedin done ==');
