// herald-linkedin publish flow (OFFICIAL REST API). Order is load-bearing and
// every external action is gated (mirrors Piper's discipline, API instead of a
// browser):
//   kill-check FIRST (fail-closed) -> item publishable? -> RE-VERIFY Vera on the
//   EXACT final text (peer review_content) -> resolve token+author URN (inline
//   refresh if expired; never a re-login) -> SPEC-D caps reserve-then-act
//   (hard-stop aborts) -> ONLY IF HERALD_LIVE: POST /rest/posts, capture the
//   returned post URN/permalink, commit caps, mark posted + external_ref. If NOT
//   live: rollback the reservation and record would-post (nowhere real).
import { makeKillChecker } from './controls.mjs';
import * as caps from './caps.mjs';
import { fetchToken, putToken, markInvalid } from './vault.mjs';
import { reviewContent as defReview } from './vera.mjs';
import { createPost as defCreatePost, refreshAccessToken as defRefresh, tokenEnvelope } from './linkedin.mjs';
import {
  ACTION_CLASS, HERALD_LIVE, ORG_ENABLED, ORG_ID, oauthSecretName, secrets,
} from './config.mjs';

const PUBLISHABLE = new Set(['vera_pass', 'approved', 'scheduled']);
const LINKEDIN_PLATFORMS = new Set(['linkedin_personal', 'linkedin_company']);

async function finish(db, runId, status, extra = {}) {
  if (db && runId) await db.patchRun(runId, { status: mapRun(status), finished_at: new Date().toISOString(), result: { status, ...extra } }).catch(() => {});
  return { status, ...extra };
}
const mapRun = (s) => ({ ok: 'ok', skipped: 'ok', killed: 'killed', refused: 'refused', caps_stop: 'ok', token_invalid: 'ok', error: 'error' }[s] || 'ok');

// Refresh an access token inline when it is expired/nearing expiry. Returns the
// (possibly new) access token, or null if refresh was impossible.
async function refreshIfNeeded({ token, secretArn, s, deps }) {
  if (!token.expired && !token.nearingExpiry) return token.accessToken;
  if (!token.refreshToken) return token.expired ? null : token.accessToken;
  const clientId = s['client-id'];
  const clientSecret = s['client-secret'];
  if (!clientId || !clientSecret) return token.expired ? null : token.accessToken;
  const refresh = deps.refreshAccessToken || defRefresh;
  let raw;
  try { raw = await refresh({ refreshToken: token.refreshToken, clientId, clientSecret, fetchImpl: deps.fetch }); }
  catch { return token.expired ? null : token.accessToken; }
  const env = tokenEnvelope(raw, { authorUrn: token.authorUrn, scope: token.scope });
  if (!env.refresh_token) env.refresh_token = token.refreshToken;
  await putToken({ secretArn, envelope: env, putSecret: deps.putSecret }).catch(() => {});
  return env.access_token;
}

export async function publishItem({ db, item, runId, now = () => new Date(), deps = {} } = {}) {
  const live = deps.live != null ? deps.live : HERALD_LIVE;
  const person = item.person;
  const platform = item.platform;
  const actionClass = ACTION_CLASS[item.kind] || null;
  const checkKill = deps.checkKill || makeKillChecker(db);
  const emit = (event_type, payload = {}) =>
    db.insertEvent({ agent: 'linkedin', person, subject_id: item.id, event_type, payload: { runId, platform, ...payload } }).catch(() => {});

  // 1) Kill-check first, fail-closed.
  const k1 = await checkKill(person);
  if (!k1.ok) {
    await emit(k1.action === 'kill' ? 'kill_switch.engaged' : 'caps.warning', { enforced: true, reason: k1.reason });
    return finish(db, runId, k1.action === 'kill' ? 'killed' : 'refused', { reason: k1.reason });
  }
  // 2) Only publishable rows on a LinkedIn platform proceed.
  if (!LINKEDIN_PLATFORMS.has(platform)) return finish(db, runId, 'skipped', { reason: `platform ${platform} is not LinkedIn` });
  if (!PUBLISHABLE.has(item.status)) return finish(db, runId, 'skipped', { reason: `status ${item.status} not publishable` });
  if (!actionClass) { await emit('caps.stop', { reason: 'no_action_class', kind: item.kind }); return finish(db, runId, 'error', { reason: 'unmapped_kind' }); }

  // 3) RE-VERIFY Vera on the EXACT final text (the Vera gate is never skipped).
  const g = await (deps.reviewContent || defReview)({
    runId, content: { person, platform, kind: item.kind, body: item.body }, invokeImpl: deps.veraInvoke,
  });
  if (g.verdict !== 'pass') {
    await db.patchQueueItem(item.id, { status: 'bounced', vera_verdict: g.vera, updated_at: new Date().toISOString() }).catch(() => {});
    await emit('content.vera_bounce', { rule_ids: g.vera.rule_ids, phase: 're_verify', blocked: !!g.blocked });
    return finish(db, runId, 'refused', { reason: 'vera_bounce', rule_ids: g.vera.rule_ids });
  }

  // 4) Resolve author URN + a usable access token (personal vs company page).
  let accessToken = null;
  let authorUrn = null;
  const s = await secrets();
  if (platform === 'linkedin_company') {
    if (!ORG_ENABLED || !ORG_ID) { await emit('caps.stop', { reason: 'org_disabled' }); return finish(db, runId, 'skipped', { reason: 'org_disabled' }); }
    authorUrn = `urn:li:organization:${ORG_ID}`;
  }
  const secretArn = deps.secretArn || oauthSecretName(person);
  const token = await fetchToken({ secretArn, getSecret: deps.getSecret });
  if (!token.ok) {
    await markInvalid({ db, person, secretArn, reasonCode: token.reason });
    return finish(db, runId, 'token_invalid', { reason: token.reason });
  }
  accessToken = await refreshIfNeeded({ token, secretArn, s, deps });
  if (!accessToken) {
    await markInvalid({ db, person, secretArn, reasonCode: 'expired_no_refresh' });
    return finish(db, runId, 'token_invalid', { reason: 'expired_no_refresh' });
  }
  if (platform === 'linkedin_personal') {
    authorUrn = token.authorUrn;
    if (!authorUrn) { await emit('caps.stop', { reason: 'no_author_urn' }); return finish(db, runId, 'token_invalid', { reason: 'no_author_urn' }); }
  }

  // 5) Reserve the action (reserve-then-act). HARD-STOP aborts the whole run.
  const res = await caps.reserve(db, { person, platform, actionClass, now: now() });
  if (!res.allowed) {
    await emit('caps.stop', { action_class: actionClass, reason: res.reason, window: res.window || null, hard_stop: true });
    return finish(db, runId, 'caps_stop', { reason: res.reason, actionClass });
  }

  // 6) DRY-RUN default: prove the whole path, release the reservation (a
  //    rehearsal must not burn a real slot), and record what WOULD post. NO API.
  if (!live) {
    await caps.rollback(db, person, platform, actionClass, res.windows).catch(() => {});
    const externalRef = `dryrun:linkedin:${item.id}`;
    await emit('content.would_post', { dry_run: true, author_urn: authorUrn, action_class: actionClass, body_chars: (item.body || '').length, external_ref: externalRef });
    return finish(db, runId, 'ok', { dryRun: true, externalRef, authorUrn });
  }

  // 7) LIVE: POST to LinkedIn /rest/posts, capture the post URN + permalink.
  let pub;
  try {
    pub = await (deps.createPost || defCreatePost)({ accessToken, authorUrn, commentary: item.body, fetchImpl: deps.fetch });
  } catch (e) {
    await caps.rollback(db, person, platform, actionClass, res.windows).catch(() => {});
    await db.patchQueueItem(item.id, { status: 'bounced', updated_at: new Date().toISOString() }).catch(() => {});
    await emit('content.publish_failed', { reason: e.message, status: e.status || null });
    return finish(db, runId, 'error', { reason: e.message });
  }
  await caps.commit(db, person, platform, actionClass, res.windows).catch(() => {});
  const externalRef = pub.permalink || pub.postUrn || 'posted';
  await db.patchQueueItem(item.id, { status: 'posted', external_ref: externalRef, posted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).catch(() => {});
  await emit('content.posted', { external_ref: externalRef, post_urn: pub.postUrn || null, dry_run: false, action_class: actionClass });
  return finish(db, runId, 'ok', { dryRun: false, externalRef, postUrn: pub.postUrn || null, authorUrn });
}

// Schedule sweep: publish every due scheduled LinkedIn item now (LinkedIn has no
// scheduling endpoint, so HERALD schedules and posts on wake).
export async function publishDue({ db, runId, now = () => new Date(), deps = {} } = {}) {
  const nowIso = now().toISOString();
  const due = await db.listDue(nowIso, deps.limit || 10);
  const results = [];
  for (const item of due) {
    const out = await publishItem({ db, item, runId: null, now, deps });
    results.push({ id: item.id, status: out.status, reason: out.reason || null });
  }
  return finish(db, runId, 'ok', { swept: due.length, results });
}

// refresh_tokens: refresh access tokens nearing expiry for the known roster.
export async function refreshTokens({ db, runId, deps = {} } = {}) {
  const s = await secrets();
  const persons = deps.persons || (await import('./config.mjs')).REFRESH_PERSONS;
  const refresh = deps.refreshAccessToken || defRefresh;
  const results = [];
  for (const person of persons) {
    const secretArn = deps.secretArn || oauthSecretName(person);
    const token = await fetchToken({ secretArn, getSecret: deps.getSecret });
    if (!token.ok) { results.push({ person, action: 'skip', reason: token.reason }); continue; }
    if (!token.nearingExpiry) { results.push({ person, action: 'skip', reason: 'not_due' }); continue; }
    if (!token.refreshToken || !s['client-id'] || !s['client-secret']) { results.push({ person, action: 'skip', reason: 'no_refresh_material' }); continue; }
    try {
      const raw = await refresh({ refreshToken: token.refreshToken, clientId: s['client-id'], clientSecret: s['client-secret'], fetchImpl: deps.fetch });
      const env = tokenEnvelope(raw, { authorUrn: token.authorUrn, scope: token.scope });
      if (!env.refresh_token) env.refresh_token = token.refreshToken;
      await putToken({ secretArn, envelope: env, putSecret: deps.putSecret });
      await db.insertEvent({ agent: 'linkedin', person, event_type: 'token.refreshed', payload: { runId, expires_at: env.expires_at } }).catch(() => {});
      results.push({ person, action: 'refreshed', expires_at: env.expires_at });
    } catch (e) {
      results.push({ person, action: 'error', reason: e.message });
    }
  }
  return finish(db, runId, 'ok', { results });
}
