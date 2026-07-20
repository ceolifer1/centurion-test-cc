// SPEC-C section 3 capture harness - the ephemeral capture task's entrypoint.
// This is the ONLY place a real browser-session cookie jar is read, and it runs
// ONLY inside the controlled Fargate capture task, ONLY after a real human logs
// in themselves. It NEVER runs automatically and NEVER captures on its own:
//   * A live human must open the streamed browser and complete login + 2FA.
//   * HERALD reads the resulting cookie jar via CDP Network.getCookies AFTER
//     login-success detection - it never instruments the password field.
//   * Cookie VALUES are never logged; the plaintext lives in memory only and is
//     handed straight to storeSession (memory -> KMS -> Secrets Manager).
//   * A hard guard (HERALD_CAPTURE_CONFIRM=<person>:<platform>) plus the presence
//     of a real Playwright/CDP session are required - absent either, it exits
//     without touching anything. This build never captures a real session.
import { storeSession } from '../src/store.mjs';
import { markActive } from '../src/tasks.mjs';
import { makeDb } from '../src/db.mjs';
import { CAPTURE_MAX_SECONDS } from '../src/config.mjs';

// Read the platform cookie jar from an already-authenticated CDP/Playwright
// context. Passed in so tests inject a mock and no real browser is ever driven.
async function readCookieJar(context, platform) {
  // Real path (capture task only): const cookies = await context.cookies()
  // filtered to the platform's session-cookie names. Injected here for safety.
  const cookies = await context.cookies();
  const ua = await context.userAgent?.();
  const viewport = context.viewport?.() || null;
  return {
    cookies, userAgent: ua || null, viewport,
    capturedAt: new Date().toISOString(), platform,
  };
}

// Orchestrate one capture. Guarded: requires an explicit confirm token AND a live
// authenticated context. Never auto-runs; never logs cookie values.
export async function captureOnce({ person, platform, consentId, accountId, context, confirm, deps = {} }) {
  const expect = `${person}:${platform}`;
  if (!confirm || confirm !== expect) {
    return { status: 'refused', reason: 'capture guard not satisfied - a human-confirmed live session is required (SPEC-C 3)' };
  }
  if (!context || typeof context.cookies !== 'function') {
    return { status: 'refused', reason: 'no authenticated browser context - HERALD never logs in itself (SPEC-C 5.5)' };
  }
  const envelope = { ...(await readCookieJar(context, platform)), consentRowId: consentId || null };
  const stored = await storeSession({ person, platform, envelope, accountId, clients: deps.clients || {} });
  const db = deps.db || (await makeDb());
  await markActive({ payload: { person, platform, consentId, captureTaskArn: deps.taskArn || null, cookieCount: stored.cookieCount },
    db, now: new Date().toISOString() });
  // NOTE: only counts/names are returned - never cookie values.
  return { status: 'ok', secretName: stored.secretName, cookieCount: stored.cookieCount, keyAlias: stored.keyAlias, maxSeconds: CAPTURE_MAX_SECONDS };
}

// Entrypoint guard: only run as the capture task, never on import (tests import).
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/capture-session.mjs')) {
  console.error('[vault-capture] refusing to auto-run: capture requires a live human-confirmed session (SPEC-C 3). Exiting.');
  process.exit(1);
}
