// LinkedIn OFFICIAL REST client: exact endpoint, versioning + protocol headers,
// /rest/posts body shape, post-URN capture from x-restli-id, OAuth token calls,
// and userinfo -> author URN. All fetch is mocked; the real API is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './fixtures.mjs';
import {
  buildPostBody, createPost, exchangeCode, refreshAccessToken, fetchAuthorUrn, tokenEnvelope,
} from '../src/linkedin.mjs';

test('buildPostBody matches the Posts API text-only sample (author/commentary/PUBLIC/MAIN_FEED/PUBLISHED)', () => {
  const b = buildPostBody({ authorUrn: 'urn:li:person:ABC', commentary: 'hello' });
  assert.equal(b.author, 'urn:li:person:ABC');
  assert.equal(b.commentary, 'hello');
  assert.equal(b.visibility, 'PUBLIC');
  assert.equal(b.lifecycleState, 'PUBLISHED');
  assert.equal(b.isReshareDisabledByAuthor, false);
  assert.deepEqual(b.distribution, { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] });
});

test('createPost posts to /rest/posts with LinkedIn-Version + X-Restli-Protocol-Version and returns the post URN + permalink', async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { status: 201, ok: true, headers: new Map([['x-restli-id', 'urn:li:share:12345']]), text: async () => '' };
  };
  const out = await createPost({ accessToken: 'TKN', authorUrn: 'urn:li:person:ABC', commentary: 'body', version: '202506', fetchImpl });
  assert.equal(seen.url, 'https://api.linkedin.com/rest/posts');
  assert.equal(seen.opts.headers['X-Restli-Protocol-Version'], '2.0.0');
  assert.equal(seen.opts.headers['LinkedIn-Version'], '202506');
  assert.equal(seen.opts.headers.Authorization, 'Bearer TKN');
  assert.equal(out.postUrn, 'urn:li:share:12345');
  assert.equal(out.permalink, 'https://www.linkedin.com/feed/update/urn:li:share:12345/');
});

test('createPost throws on a non-2xx (e.g. 403 ACCESS_DENIED) without echoing the token', async () => {
  const fetchImpl = async () => ({ status: 403, ok: false, headers: new Map(), text: async () => '{"code":"ACCESS_DENIED"}' });
  await assert.rejects(() => createPost({ accessToken: 'TKN', authorUrn: 'urn:li:person:ABC', commentary: 'x', fetchImpl }),
    (e) => e.status === 403 && /ACCESS_DENIED/.test(e.message) && !/TKN/.test(e.message));
});

test('exchangeCode + refreshAccessToken hit /oauth/v2/accessToken with x-www-form-urlencoded grants', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url, opts }); return { ok: true, json: async () => ({ access_token: 'A', expires_in: 5184000 }) }; };
  await exchangeCode({ code: 'c', clientId: 'id', clientSecret: 'sec', redirectUri: 'http://localhost:8737/callback', fetchImpl });
  await refreshAccessToken({ refreshToken: 'r', clientId: 'id', clientSecret: 'sec', fetchImpl });
  assert.ok(seen[0].url.endsWith('/oauth/v2/accessToken'));
  assert.equal(seen[0].opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.match(seen[0].opts.body, /grant_type=authorization_code/);
  assert.match(seen[1].opts.body, /grant_type=refresh_token/);
});

test('fetchAuthorUrn maps userinfo.sub -> urn:li:person:{sub}', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ sub: 'XYZ789', name: 'A C' }) });
  const out = await fetchAuthorUrn({ accessToken: 'TKN', fetchImpl });
  assert.equal(out.authorUrn, 'urn:li:person:XYZ789');
  assert.equal(out.sub, 'XYZ789');
});

test('tokenEnvelope computes expires_at from expires_in and carries author_urn + scope', () => {
  const env = tokenEnvelope({ access_token: 'A', refresh_token: 'R', expires_in: 100, scope: 'w_member_social' }, { authorUrn: 'urn:li:person:ABC' });
  assert.equal(env.access_token, 'A');
  assert.equal(env.refresh_token, 'R');
  assert.equal(env.author_urn, 'urn:li:person:ABC');
  assert.ok(env.expires_at > Math.floor(Date.now() / 1000));
});
