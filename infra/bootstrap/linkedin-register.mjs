// HERALD registry step for herald-linkedin (SPEC-H section 7). Verifies GET
// /manifest = 200 via aws lambda invoke (AWS_IAM), upserts the herald_agents row
// (Presence roster / LINDA routing table), and writes the two herald_schedules
// rows (EventBridge is the executor; this table is the truth). health=amber
// until a token is vaulted + HERALD_LIVE is flipped.
// Run: node <ascend>/infra/bootstrap/run-with-aws.mjs -- node linkedin-register.mjs
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { resolve } = await import('file:///C:/Claude/.op-agent/op.mjs');
const CF = 'https://hruwrnbrlnitytneeafv.supabase.co';
const AWS = 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe';
const FN = 'herald-linkedin-prod';
const URL = 'https://5cmwogepbjdzujp4wrignfkgwq0cnqzm.lambda-url.us-east-1.on.aws/';
const svc = (await resolve('op://CIOS-prod/cf-service-role/credential')).trim();
const H = { apikey: svc, Authorization: `Bearer ${svc}`, 'Content-Type': 'application/json' };

function invoke(event) {
  const ev = join(tmpdir(), `ev-li-${Date.now()}.json`);
  const out = join(tmpdir(), `out-li-${Date.now()}.json`);
  writeFileSync(ev, JSON.stringify(event));
  const r = spawnSync(AWS, ['lambda', 'invoke', '--function-name', FN, '--payload', `fileb://${ev}`, out, '--region', 'us-east-1'], { env: process.env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('invoke failed: ' + (r.stderr || '').slice(0, 200));
  return JSON.parse(readFileSync(out, 'utf8'));
}

// 1) Manifest smoke.
const res = invoke({ requestContext: { http: { method: 'GET' } }, rawPath: '/manifest', headers: {} });
const manifest = JSON.parse(res.body || '{}');
const ok = res.statusCode === 200;
console.log(`manifest -> ${res.statusCode} caps=[${(manifest.capabilities || []).join(', ')}] api.scope=${manifest.api?.scope}`);

// 2) herald_agents upsert.
const ar = await fetch(`${CF}/rest/v1/herald_agents?on_conflict=agent`, {
  method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify({ agent: 'linkedin', service: 'herald-linkedin-prod', variant: 'lambda', endpoint: URL,
    manifest, cost_class: manifest.cost_class || 'low', health: ok ? 'amber' : 'red', updated_at: new Date().toISOString() }),
});
console.log(`herald_agents upsert -> ${ar.status}${ar.ok ? '' : ' ' + (await ar.text()).slice(0, 160)} (amber: armed but no token/live yet)`);

// 3) herald_schedules rows (idempotent by eb_schedule_name).
const schedules = [
  { agent: 'linkedin', name: 'linkedin-publish', cadence: 'cron(5 9 ? * MON-FRI *)', timezone: 'America/Chicago',
    payload: { task: 'publish_due' }, mode: 'dry_run', enabled: false, eb_schedule_name: 'herald-linkedin-publish-prod',
    sync_state: 'synced', last_synced_at: new Date().toISOString(), created_by: 'linkedin-register' },
  { agent: 'linkedin', name: 'linkedin-refresh', cadence: 'cron(0 6 * * ? *)', timezone: 'America/Chicago',
    payload: { task: 'refresh_tokens' }, mode: 'dry_run', enabled: false, eb_schedule_name: 'herald-linkedin-refresh-prod',
    sync_state: 'synced', last_synced_at: new Date().toISOString(), created_by: 'linkedin-register' },
];
for (const s of schedules) {
  const q = await fetch(`${CF}/rest/v1/herald_schedules?eb_schedule_name=eq.${s.eb_schedule_name}&select=id`, { headers: H });
  const existing = await q.json();
  if (Array.isArray(existing) && existing.length) { console.log(`herald_schedules ${s.eb_schedule_name} exists (${existing[0].id}) - skip`); continue; }
  const r = await fetch(`${CF}/rest/v1/herald_schedules`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(s) });
  console.log(`herald_schedules insert ${s.eb_schedule_name} -> ${r.status}${r.ok ? '' : ' ' + (await r.text()).slice(0, 160)}`);
}
console.log('== linkedin register done ==');
