// Container entrypoint (PID 1). Two independent runtime walls (SPEC-B 4.5): this
// in-container watchdog hard-exits at MAX_RUNTIME_SECONDS (graceful window at
// T-60s), and an out-of-container one-shot StopTask schedule is the backstop -
// which this task deletes itself on clean exit. Input arrives as env on the
// RunTask override: RUN_ID + CONTENT_ID (or PAYLOAD_REF = herald_runs.id).
import { makeDb } from './db.mjs';
import { runOnce } from './run.mjs';
import { MAX_RUNTIME_SECONDS, DRY_RUN, REGION } from './config.mjs';

export const MANIFEST = {
  service: 'herald-piper', agent: 'piper', engine: 'herald', version: '1.0.0',
  capabilities: ['publish', 'confirm_watch'], variant: 'fargate',
  models: {}, cost_class: 'low', dry_run_default: DRY_RUN,
  auth: { transport: 'runtask_env_payload', app: 'service_role+per_user_kms_session' },
  kill_switch_scopes: ['global', 'agent', 'user'], owner: 'centurionfinancial.com',
};

async function deleteStopSchedule() {
  const name = process.env.STOP_SCHEDULE_NAME;
  if (!name) return;
  try {
    const { SchedulerClient, DeleteScheduleCommand } = await import('@aws-sdk/client-scheduler');
    await new SchedulerClient({ region: REGION }).send(new DeleteScheduleCommand({ Name: name }));
  } catch { /* backstop schedule will fire harmlessly if this fails */ }
}

export async function main() {
  const runId = process.env.RUN_ID || null;
  const contentId = process.env.CONTENT_ID || process.env.PAYLOAD_REF || null;
  const wall = MAX_RUNTIME_SECONDS * 1000;
  const graceful = setTimeout(() => console.error('[piper] watchdog: T-60s graceful window'), Math.max(0, wall - 60000));
  const hard = setTimeout(() => { console.error('[piper] watchdog: MAX_RUNTIME_SECONDS hit - exit 1'); process.exit(1); }, wall);
  graceful.unref?.(); hard.unref?.();
  try {
    if (!contentId) { console.error('[piper] no CONTENT_ID/PAYLOAD_REF - nothing to publish'); return process.exit(1); }
    const db = await makeDb();
    const item = await db.getQueueItem(contentId);
    if (!item) { console.error(`[piper] queue item ${contentId} not found`); return process.exit(1); }
    const out = await runOnce({ db, item, runId });
    console.error(`[piper] run ${runId} -> ${out.status}${out.reason ? ` (${out.reason})` : ''}`);
    clearTimeout(hard); clearTimeout(graceful);
    await deleteStopSchedule();
    return process.exit(['ok', 'skipped', 'session_invalid', 'caps_stop'].includes(out.status) ? 0 : 1);
  } catch (e) {
    console.error(`[piper] fatal: ${e.message}`);
    return process.exit(1);
  }
}

// Run only as the container entrypoint, never when imported by unit tests.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/entry.mjs')) main();
