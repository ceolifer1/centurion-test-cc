// LinkedIn OFFICIAL REST engagement client: exact endpoints, versioning +
// protocol headers, body shapes for reactions + comments, id capture from
// x-restli-id, and userinfo -> actor URN. All fetch is mocked; the real API is
// never touched. Grounded on Microsoft Learn (Reactions API + Network Update
// Social Actions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './fixtures.mjs';
import { createReaction, createComment, fetchAuthorUrn } from '../src/linkedin.mjs';

test('createReaction POSTs /rest/reactions?actor= with headers + { root, reactionType } and returns the reaction id', async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { status: 201, ok: true, headers: new Map([['x-restli-id', 'urn:li:reaction:(urn:li:person:ABC,urn:li:activity:66)']]), text: async () => '' };
  };
  const out = await createReaction({ accessToken: 'TKN', actorUrn: 'urn:li:person:ABC', targetUrn: 'urn:li:activity:66', reactionType: 'PRAISE', version: '202606', fetchImpl });
  assert.match(seen.url, /\/rest\/reactions\?actor=urn%3Ali%3Aperson%3AABC$/);
  assert.equal(seen.opts.headers['X-Restli-Protocol-Version'], '2.0.0');
  assert.equal(seen.opts.headers['LinkedIn-Version'], '202606');
  assert.equal(seen.opts.headers.Authorization, 'Bearer TKN');
  assert.deepEqual(JSON.parse(seen.opts.body), { root: 'urn:li:activity:66', reactionType: 'PRAISE' });
  assert.equal(out.reactionType, 'PRAISE');
  assert.match(out.reactionId, /^urn:li:reaction:/);
});

test('createReaction defaults an unknown reactionType to LIKE (MAYBE is deprecated / omitted)', async () => {
  let body = null;
  const fetchImpl = async (url, opts) => { body = JSON.parse(opts.body); return { status: 201, ok: true, headers: new Map(), text: async () => '' }; };
  await createReaction({ accessToken: 'T', actorUrn: 'urn:li:person:A', targetUrn: 'urn:li:activity:1', reactionType: 'MAYBE', fetchImpl });
  assert.equal(body.reactionType, 'LIKE');
});

test('createComment POSTs /rest/socialActions/{targetUrn}/comments with { actor, object, message.text } and returns the comment URN', async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { status: 201, ok: true, headers: new Map([['x-restli-id', 'urn:li:comment:(urn:li:activity:66,7102)']]), text: async () => '' };
  };
  const out = await createComment({ accessToken: 'TKN', actorUrn: 'urn:li:person:ABC', targetUrn: 'urn:li:activity:66', message: 'Congrats on the milestone.', version: '202606', fetchImpl });
  assert.match(seen.url, /\/rest\/socialActions\/urn%3Ali%3Aactivity%3A66\/comments$/);
  assert.equal(seen.opts.headers['X-Restli-Protocol-Version'], '2.0.0');
  assert.equal(seen.opts.headers['LinkedIn-Version'], '202606');
  const b = JSON.parse(seen.opts.body);
  assert.equal(b.actor, 'urn:li:person:ABC');
  assert.equal(b.object, 'urn:li:activity:66');
  assert.deepEqual(b.message, { text: 'Congrats on the milestone.' });
  assert.match(out.commentUrn, /^urn:li:comment:/);
});

test('createReaction throws on a non-2xx (e.g. 403 ACCESS_DENIED) without echoing the token', async () => {
  const fetchImpl = async () => ({ status: 403, ok: false, headers: new Map(), text: async () => '{"code":"ACCESS_DENIED"}' });
  await assert.rejects(() => createReaction({ accessToken: 'TKN', actorUrn: 'urn:li:person:A', targetUrn: 'urn:li:activity:1', fetchImpl }),
    (e) => e.status === 403 && /ACCESS_DENIED/.test(e.message) && !/TKN/.test(e.message));
});

test('fetchAuthorUrn maps userinfo.sub -> urn:li:person:{sub}', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ sub: 'XYZ789', name: 'A C' }) });
  const out = await fetchAuthorUrn({ accessToken: 'TKN', fetchImpl });
  assert.equal(out.authorUrn, 'urn:li:person:XYZ789');
  assert.equal(out.sub, 'XYZ789');
});
