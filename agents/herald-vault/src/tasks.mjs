// herald-vault tasks (SPEC-C). The Lambda handles consent + revoke + status and
// NEVER reads or writes cookie plaintext. Cookie capture + encrypt + store is the
// capture fargate task's job (store.mjs, called from scripts/capture-session.mjs
// after a real human login). Ordering rule (SPEC-C 3.2 / 7): the consent ledger
// row exists BEFORE any secret does.
import { SESSION_PLATFORMS, sessionSecretName, CAPTURE_TASKDEF } from './config.mjs';
import { pendingConsentRow, CAPABILITY_STRINGS } from './consent.mjs';
import { revokeSession as revokeStore } from './store.mjs';

// 1) initiate_consent: write the PENDING ledger row BEFORE any secret exists, then
//    (optionally) launch the ephemeral capture task. Captures NOTHING itself.
export async function initiateConsent({ payload, db, now, deps = {} }) {
  const { person, platform, grantedBy, scope } = payload;
  if (!person || !platform) return { status: 'error', error: 'person + platform required' };
  if (!SESSION_PLATFORMS.includes(platform)) return { status: 'error', error: `platform ${platform} is not a vaulted-session platform` };

  const row = pendingConsentRow({ person, platform, grantedBy, scope, now: () => now });
  const rec = await db.insertConsent(row);
  await db.insertEvent({ agent: 'vault', person, subject_id: null, event_type: 'consent.initiated',
    payload: { platform, consent_id: rec.id, scope: row.scope, granted_by: row.granted_by } }).catch(() => {});

  // The capture task is launched only if a launcher is wired (deploy window). It
  // runs a clean Playwright browser the human logs into; HERALD never sees the
  // password. This function returns before any cookie exists.
  let captureLaunched = false;
  if (typeof deps.launchCapture === 'function') {
    try { await deps.launchCapture({ person, platform, consentId: rec.id, taskDef: CAPTURE_TASKDEF }); captureLaunched = true; }
    catch { captureLaunched = false; }
  }
  return { status: 'ok', eventType: 'consent.initiated', person, subjectId: rec.id,
    reply: `Consent recorded (PENDING). ${captureLaunched ? 'Capture session launched.' : 'Launch the capture task to log in.'}`,
    payloadOut: { consent_id: rec.id, platform, scope: row.scope, capture_launched: captureLaunched } };
}

// 2) mark_active: the capture task calls this AFTER storeSession succeeded. Flip
//    the ledger PENDING -> ACTIVE. Audits counts + names only (SPEC-C T3).
export async function markActive({ payload, db, now }) {
  const { person, platform, consentId, captureTaskArn, cookieCount } = payload;
  if (!person || !platform) return { status: 'error', error: 'person + platform required' };
  const rec = consentId ? { id: consentId } : (await db.latestConsent(person, platform));
  if (!rec) return { status: 'error', error: 'no consent row to activate (initiate_consent first)' };
  await db.patchConsent(rec.id, { status: 'ACTIVE', capture_task_arn: captureTaskArn || null });
  await db.insertEvent({ agent: 'vault', person, subject_id: null, event_type: 'session.captured',
    payload: { platform, consent_id: rec.id, cookie_count: Number(cookieCount) || null, secret: sessionSecretName(person, platform), captured_at: now } }).catch(() => {});
  return { status: 'ok', eventType: 'session.captured', person, subjectId: rec.id,
    reply: `Session vaulted - consent ACTIVE for ${person}/${platform}.`,
    payloadOut: { consent_id: rec.id, state: 'ACTIVE' } };
}

// 3) revoke_session (SPEC-C 6): destructive + instant. Runs even under kill (a
//    security control must work mid-incident). DeleteSecret (no recovery) + retire
//    grants + StopTask running tasks + zero the capability grant + ledger REVOKED.
export async function revokeSession({ payload, db, now, deps = {} }) {
  const { person, platform, revokedBy, userId } = payload;
  if (!person || !platform) return { status: 'error', error: 'person + platform required' };

  const teardown = await revokeStore({ person, platform, clients: deps.clients || {} });
  const capStrings = CAPABILITY_STRINGS[platform] || [];
  const grant = await db.zeroGrant(userId, capStrings).catch(() => ({ zeroed: false }));
  const rec = await db.latestConsent(person, platform).catch(() => null);
  if (rec) await db.patchConsent(rec.id, { status: 'REVOKED', revoked_at: now, revoked_by: revokedBy || 'admin' }).catch(() => {});
  await db.insertEvent({ agent: 'vault', person, subject_id: rec?.id || null, event_type: 'session.revoked',
    payload: { platform, secret_deleted: teardown.secretDeleted, tasks_stopped: teardown.tasksStopped,
      grant_zeroed: !!grant.zeroed, revoked_by: revokedBy || 'admin' } }).catch(() => {});
  return { status: 'ok', eventType: 'session.revoked', person, subjectId: rec?.id || null,
    reply: `Revoked ${person}/${platform}: secret deleted=${teardown.secretDeleted}, tasks stopped=${teardown.tasksStopped}, grant zeroed=${!!grant.zeroed}.`,
    payloadOut: { state: 'REVOKED', ...teardown, grant_zeroed: !!grant.zeroed } };
}

// 4) session_status: report the (person, platform) state from the ledger.
export async function sessionStatus({ payload, db }) {
  const { person, platform } = payload;
  if (!person || !platform) return { status: 'error', error: 'person + platform required' };
  const rec = await db.latestConsent(person, platform).catch(() => null);
  const state = rec?.status || 'NOT_CONNECTED';
  return { status: 'ok', eventType: 'session.status', person,
    reply: `${person}/${platform}: ${state}`,
    payloadOut: { state, consent_id: rec?.id || null, secret: sessionSecretName(person, platform) } };
}
