// LinkedIn OFFICIAL REST engagement client. Grounded verbatim on Microsoft Learn
// (LinkedIn's official versioned API docs, where LinkedIn's "Develop with MCP"
// docs point):
//   Reactions API  : POST https://api.linkedin.com/rest/reactions?actor={personUrn}
//                    headers: Authorization: Bearer <member token>,
//                             X-Restli-Protocol-Version: 2.0.0,
//                             LinkedIn-Version: YYYYMM, Content-Type: application/json
//                    body   : { root: <activity|share|ugcPost URN>, reactionType }
//                    success: 201 Created  (reaction id in body / x-restli-id)
//                    scope  : w_member_social_feed (Community Management API)
//   Social Actions : POST https://api.linkedin.com/rest/socialActions/{targetUrn}/comments
//     (comments)     headers: (same as above)
//                    body   : { actor: <personUrn>, object: <targetUrn>, message:{ text } }
//                    success: 201 Created  (comment id in x-restli-id / commentUrn)
//                    scope  : w_member_social_feed (Community Management API)
//   Author URN     : GET https://api.linkedin.com/v2/userinfo -> sub ->
//                    urn:li:person:{sub}  (OpenID Connect userinfo)
// docs: learn.microsoft.com/.../community-management/shares/reactions-api and
//       learn.microsoft.com/.../community-management/shares/network-update-social-actions
// fetch is injected so unit tests never touch the network. No secrets logged.
import { LINKEDIN_API_BASE, LINKEDIN_VERSION, DEFAULT_REACTION, REACTION_TYPES } from './config.mjs';

const restHeaders = (accessToken, version) => ({
  Authorization: `Bearer ${accessToken}`,
  'X-Restli-Protocol-Version': '2.0.0',
  'LinkedIn-Version': version,
  'Content-Type': 'application/json',
});

function headerVal(r, name) {
  try {
    if (r.headers && typeof r.headers.get === 'function') return r.headers.get(name);
    return (r.headers || {})[name] || (r.headers || {})[name.toLowerCase()] || null;
  } catch { return null; }
}

// Create a REACTION on a target share/post URN on behalf of a member (Reactions
// API - "Create a Reaction on a Share"). actor is a query param (encoded person
// URN); the target URN is the body `root`. Returns { status, reactionId, reactionType }.
// Throws on non-2xx with the LinkedIn error body (truncated, token never echoed).
export async function createReaction({ accessToken, actorUrn, targetUrn, reactionType = DEFAULT_REACTION, version = LINKEDIN_VERSION, fetchImpl = fetch }) {
  if (!accessToken) throw new Error('createReaction: missing access token');
  if (!actorUrn) throw new Error('createReaction: missing actor URN');
  if (!targetUrn) throw new Error('createReaction: missing target URN');
  const type = REACTION_TYPES.includes(reactionType) ? reactionType : DEFAULT_REACTION;
  const url = `${LINKEDIN_API_BASE}/rest/reactions?actor=${encodeURIComponent(actorUrn)}`;
  const r = await fetchImpl(url, {
    method: 'POST', headers: restHeaders(accessToken, version),
    body: JSON.stringify({ root: targetUrn, reactionType: type }),
  });
  const status = r.status;
  if (status !== 201 && status !== 200) {
    const errText = await r.text().catch(() => '');
    const e = new Error(`linkedin /rest/reactions ${status}: ${errText.slice(0, 300)}`);
    e.status = status; throw e;
  }
  return { status, reactionId: headerVal(r, 'x-restli-id') || null, reactionType: type };
}

// Create a COMMENT on a target share/post URN on behalf of a member (Social
// Actions API - "Create Comment"). The target URN is in the path; actor + object
// + message.text in the body. Returns { status, commentUrn }.
export async function createComment({ accessToken, actorUrn, targetUrn, message, version = LINKEDIN_VERSION, fetchImpl = fetch }) {
  if (!accessToken) throw new Error('createComment: missing access token');
  if (!actorUrn) throw new Error('createComment: missing actor URN');
  if (!targetUrn) throw new Error('createComment: missing target URN');
  if (!message) throw new Error('createComment: missing message text');
  const url = `${LINKEDIN_API_BASE}/rest/socialActions/${encodeURIComponent(targetUrn)}/comments`;
  const r = await fetchImpl(url, {
    method: 'POST', headers: restHeaders(accessToken, version),
    body: JSON.stringify({ actor: actorUrn, object: targetUrn, message: { text: message } }),
  });
  const status = r.status;
  if (status !== 201 && status !== 200) {
    const errText = await r.text().catch(() => '');
    const e = new Error(`linkedin /rest/socialActions comments ${status}: ${errText.slice(0, 300)}`);
    e.status = status; throw e;
  }
  let commentUrn = headerVal(r, 'x-restli-id');
  if (!commentUrn) { try { const b = await r.json(); commentUrn = b?.commentUrn || b?.id || null; } catch { commentUrn = null; } }
  return { status, commentUrn: commentUrn || null };
}

// OpenID Connect userinfo -> the member's stable id (sub). The actor URN for a
// personal social action is urn:li:person:{sub}. Used when the vaulted envelope
// carries no author_urn.
export async function fetchAuthorUrn({ accessToken, fetchImpl = fetch }) {
  const r = await fetchImpl(`${LINKEDIN_API_BASE}/v2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`linkedin /v2/userinfo ${r.status}: ${t.slice(0, 160)}`);
  }
  const info = await r.json();
  if (!info?.sub) throw new Error('userinfo returned no sub');
  return { sub: info.sub, authorUrn: `urn:li:person:${info.sub}`, name: info.name || null };
}
