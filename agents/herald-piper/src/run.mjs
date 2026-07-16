// Piper's single-item publish flow (SPEC-H section 4 steps 7-10). Order is
// load-bearing and every external action is gated:
//   kill-check -> item publishable? -> fetch+inject session (memory only) ->
//   login probe (fail-invalid, never relogin) -> re-check kill -> caps reserve
//   (reserve-then-act; hard-stop aborts the WHOLE run) -> publish (DRY-RUN
//   default, nowhere real) -> caps commit -> mark posted -> Vera confirm_posted.
import { makeKillChecker } from './controls.mjs';
import * as caps from './caps.mjs';
import { fetchSession, injectCookies, markInvalid } from './vault.mjs';
import { launchBrowser as defLaunch, probeLoginState as defProbe, publish as defPublish } from './publisher.mjs';
import { confirmPosted as defConfirm } from './vera.mjs';
import { ACTION_CLASS, DRY_RUN, TEST_SURFACE, sessionSecretName } from './config.mjs';

async function finish(db, runId, status, extra = {}) {
  if (db && runId) await db.patchRun(runId, { status: mapRun(status), finished_at: new Date().toISOString(), result: { status, ...extra } }).catch(() => {});
  return { status, ...extra };
}
const mapRun = (s) => ({ ok: 'ok', skipped: 'ok', killed: 'killed', refused: 'refused', caps_stop: 'ok', session_invalid: 'ok', error: 'error' }[s] || 'ok');

export async function runOnce({ db, item, runId, now = () => new Date(), deps = {} } = {}) {
  const dryRun = deps.dryRun != null ? deps.dryRun : DRY_RUN;
  const testSurface = deps.testSurface || TEST_SURFACE;
  const person = item.person;
  const platform = item.platform;
  const actionClass = ACTION_CLASS[item.kind] || null;
  const checkKill = deps.checkKill || makeKillChecker(db);
  const emit = (event_type, payload = {}) =>
    db.insertEvent({ agent: 'piper', person, subject_id: item.id, event_type, payload: { runId, platform, ...payload } }).catch(() => {});

  // 1) Kill-check first, fail closed.
  const k1 = await checkKill(person);
  if (!k1.ok) {
    await emit(k1.action === 'kill' ? 'kill_switch.engaged' : 'caps.warning', { enforced: true, reason: k1.reason });
    return finish(db, runId, k1.action === 'kill' ? 'killed' : 'refused', { reason: k1.reason });
  }
  // 2) Only approved/scheduled items publish (SPEC-G status machine).
  if (!['approved', 'scheduled'].includes(item.status)) return finish(db, runId, 'skipped', { reason: `status ${item.status} not publishable` });
  if (!actionClass) { await emit('caps.stop', { reason: 'no_action_class', kind: item.kind }); return finish(db, runId, 'error', { reason: 'unmapped_kind' }); }

  // 3) Fetch + inject the per-user session at runtime (KMS-gated, memory only).
  const secretArn = deps.secretArn || sessionSecretName(person, platform);
  const sess = await fetchSession({ secretArn, getSecret: deps.getSecret });
  if (!sess.ok) {
    // No usable session: NOT_CONNECTED (revoked/expired/deleted) or bad envelope.
    // Never attempt a login. Mark invalid + stop; the item stays unpublished.
    await markInvalid({ db, person, platform, secretArn, reasonCode: sess.reason, setLabel: deps.setLabel });
    return finish(db, runId, 'session_invalid', { reason: sess.reason });
  }

  const { browser, context } = await (deps.launchBrowser || defLaunch)({ fingerprint: sess.fingerprint });
  try {
    await injectCookies(context, sess.cookies);

    // 4) Login-state probe. Logged out/challenged -> INVALID + STOP, no relogin.
    const probeRes = await (deps.probeLoginState || defProbe)({ context, platform, probe: deps.probe });
    if (!probeRes.loggedIn) {
      await markInvalid({ db, person, platform, secretArn, reasonCode: 'logged_out', setLabel: deps.setLabel });
      return finish(db, runId, 'session_invalid', { reason: 'logged_out', reloginAttempted: false });
    }

    // 5) Re-check kill immediately before the publish-class action (SPEC-H 5.2).
    const k2 = await checkKill(person);
    if (!k2.ok) {
      await emit(k2.action === 'kill' ? 'kill_switch.engaged' : 'caps.warning', { enforced: true, reason: k2.reason, phase: 'pre_publish' });
      return finish(db, runId, k2.action === 'kill' ? 'killed' : 'refused', { reason: k2.reason });
    }

    // 6) Reserve the action (reserve-then-act). HARD-STOP aborts the whole run.
    const res = await caps.reserve(db, { person, platform, actionClass, now: now() });
    if (!res.allowed) {
      await emit('caps.stop', { action_class: actionClass, reason: res.reason, window: res.window || null, hard_stop: true });
      return finish(db, runId, 'caps_stop', { reason: res.reason, actionClass });
    }

    // 7) Publish (DRY-RUN by default -> nowhere real).
    let pub;
    try {
      pub = await (deps.publish || defPublish)({ context, item, dryRun, testSurface, livePost: deps.livePost });
    } catch (e) {
      await caps.rollback(db, person, platform, actionClass, res.windows).catch(() => {});
      await db.patchQueueItem(item.id, { status: 'bounced', updated_at: new Date().toISOString() }).catch(() => {});
      await emit('content.publish_failed', { reason: e.message });
      return finish(db, runId, 'error', { reason: e.message });
    }

    // 8) Commit the reservation + mark the item posted (dry-run marks it posted
    //    with a dryrun: external_ref so the pipeline completes end-to-end).
    await caps.commit(db, person, platform, actionClass, res.windows).catch(() => {});
    await db.patchQueueItem(item.id, { status: 'posted', external_ref: pub.externalRef, posted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).catch(() => {});
    await emit('content.posted', { external_ref: pub.externalRef, dry_run: !!pub.dryRun, surface: pub.surface || null, action_class: actionClass });

    // 9) Completion callback to Vera (best-effort; live-watch reconciliation).
    await (deps.confirmPosted || defConfirm)({
      runId, contentId: item.id, postUrl: pub.externalRef,
      chain: Array.isArray(deps.chain) ? deps.chain : ['piper'], invokeImpl: deps.veraInvoke,
    });

    return finish(db, runId, 'ok', { externalRef: pub.externalRef, dryRun: !!pub.dryRun });
  } finally {
    await browser.close?.().catch(() => {});
  }
}
