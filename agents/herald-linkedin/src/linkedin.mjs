// LinkedIn OFFICIAL REST client. Grounded verbatim on Microsoft Learn (LinkedIn's
// official API docs, where LinkedIn's "Develop with MCP" points):
//   Posts API  : POST https://api.linkedin.com/rest/posts
//                headers: Authorization: Bearer <member token>,
//                         X-Restli-Protocol-Version: 2.0.0,
//                         LinkedIn-Version: YYYYMM, Content-Type: application/json
//                body   : { author, commentary, visibility:'PUBLIC',
//                           distribution:{feedDistribution:'MAIN_FEED',
//                             targetEntities:[], thirdPartyDistributionChannels:[]},
//                           lifecycleState:'PUBLISHED', isReshareDisabledByAuthor:false }
//                success: 201, post URN in response header x-restli-id
//   3-legged OAuth: token exchange + refresh at
//                https://www.linkedin.com/oauth/v2/accessToken
//   Author URN : GET https://api.linkedin.com/v2/userinfo -> sub ->
//                urn:li:person:{sub}  (OpenID Connect userinfo)
// fetch is injected so unit tests never touch the network. No secrets logged.
import {
  LINKEDIN_API_BASE, LINKEDIN_OAUTH_BASE, LINKEDIN_VERSION,
} from './config.mjs';

// Build the Posts API request body (text-only organic post). commentary is the
// post body; visibility PUBLIC; MAIN_FEED distribution (Posts API doc samples).
export function buildPostBody({ authorUrn, commentary, visibility = 'PUBLIC' }) {
  return {
    author: authorUrn,
    commentary,
    visibility,
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
}

// POST a share to /rest/posts on behalf of the member (w_member_social) or an
// organization (w_organization_social). Returns { postUrn, permalink, status }.
// Throws on non-2xx with the LinkedIn error body (truncated, no token echoed).
export async function createPost({ accessToken, authorUrn, commentary, visibility = 'PUBLIC', version = LINKEDIN_VERSION, fetchImpl = fetch }) {
  if (!accessToken) throw new Error('createPost: missing access token');
  if (!authorUrn) throw new Error('createPost: missing author URN');
  const body = buildPostBody({ authorUrn, commentary, visibility });
  const r = await fetchImpl(`${LINKEDIN_API_BASE}/rest/posts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': version,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const status = r.status;
  if (status !== 201 && status !== 200) {
    const errText = await r.text().catch(() => '');
    const e = new Error(`linkedin /rest/posts ${status}: ${errText.slice(0, 300)}`);
    e.status = status;
    throw e;
  }
  // Post URN arrives in the x-restli-id response header (Posts API doc).
  const postUrn = headerVal(r, 'x-restli-id') || headerVal(r, 'x-linkedin-id') || null;
  const permalink = postUrn ? `https://www.linkedin.com/feed/update/${postUrn}/` : null;
  return { postUrn, permalink, status };
}

function headerVal(r, name) {
  try {
    if (r.headers && typeof r.headers.get === 'function') return r.headers.get(name);
    return (r.headers || {})[name] || (r.headers || {})[name.toLowerCase()] || null;
  } catch { return null; }
}

// OAuth token exchange (authorization_code -> tokens). Used by the local
// one-time capture helper. Returns the raw LinkedIn token JSON.
export async function exchangeCode({ code, clientId, clientSecret, redirectUri, fetchImpl = fetch }) {
  return tokenCall({
    fetchImpl,
    params: {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    },
  });
}

// Refresh an access token using the stored refresh token (LinkedIn programmatic
// refresh, 3-legged OAuth Step 5). Returns the raw LinkedIn token JSON.
export async function refreshAccessToken({ refreshToken, clientId, clientSecret, fetchImpl = fetch }) {
  if (!refreshToken) throw new Error('refreshAccessToken: missing refresh token');
  return tokenCall({
    fetchImpl,
    params: {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    },
  });
}

async function tokenCall({ fetchImpl, params }) {
  const form = new URLSearchParams(params).toString();
  const r = await fetchImpl(`${LINKEDIN_OAUTH_BASE}/oauth/v2/accessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`linkedin oauth ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

// OpenID Connect userinfo -> the member's stable id (sub). The author URN for a
// personal post is urn:li:person:{sub} (Posts API "Find Posts by Authors" +
// Sign In with LinkedIn / userinfo docs).
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

// Normalize a raw LinkedIn token response into the vault envelope shape.
export function tokenEnvelope(raw, { authorUrn, scope } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token || null,
    expires_at: now + Number(raw.expires_in || 0),
    refresh_token_expires_at: raw.refresh_token_expires_in ? now + Number(raw.refresh_token_expires_in) : null,
    scope: raw.scope || scope || null,
    author_urn: authorUrn || null,
    updated_at: new Date().toISOString(),
  };
}
