// Consent gating (VERA-N01..N05), platform ToS (P01..P07), brand (B01..B05),
// per-person DNS rules, and the SPEC-E section 4 bounce JSON shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/engine.mjs';
import { ASHTON, JASMINE, ANWAR, SIGNED_ANWAR, STEPHEN, CLEAN_ITEM, item } from './fixtures.mjs';

const ev = (it, ctx = {}) => evaluate(it, { factFile: ASHTON, ...ctx });
const fires = (v, id) => v.rule_ids.includes(id);
const flagged = (v, id) => v.flag_ids.includes(id);

test('VERA-N01 client named without consent blocks; with consent passes', () => {
  const clients = [{ name: 'Emergent Biosciences', client_name_consent: false }];
  const v = ev(item('Proud to advise Emergent Biosciences on their program.'), { clients });
  assert.ok(fires(v, 'VERA-N01'));
  const ok = ev(item('Proud to advise Emergent Biosciences on their program.'),
    { clients: [{ name: 'Emergent Biosciences', client_name_consent: true }] });
  assert.ok(!fires(ok, 'VERA-N01'));
});

test('VERA-N02 exact deal size without consent blocks; size band passes', () => {
  const deal = { client_name_consent: false };
  assert.ok(fires(ev(item('We closed a $12,500,000 facility for the sponsor.'), { deal }), 'VERA-N02'));
  const band = ev(item('We closed a $5-15M facility for the sponsor.'), { deal });
  assert.ok(!fires(band, 'VERA-N02'));
  const plusBand = ev(item('A $50M+ mandate in the Southeast.'), { deal });
  assert.ok(!fires(plusBand, 'VERA-N02'));
});

test('VERA-N03 hard gate: Anwar draft_only blocks; signed-off fact-file passes', () => {
  const anwarItem = { ...CLEAN_ITEM, person: 'anwar-ferguson', body: 'A clean institutional post.' };
  const v = evaluate(anwarItem, { factFile: ANWAR });
  assert.equal(v.verdict, 'bounce');
  assert.ok(fires(v, 'VERA-N03'));
  const ok = evaluate(anwarItem, { factFile: SIGNED_ANWAR });
  assert.ok(!fires(ok, 'VERA-N03'));
  assert.equal(ok.verdict, 'pass');
});

test('VERA-N03: Stephen (bio_submitted) blocks; Jasmine blocks until her TODO consent record is filled (SPEC-E 3.2 note)', () => {
  const s = evaluate({ ...CLEAN_ITEM, person: 'stephen-warren', body: 'Clean copy.' }, { factFile: STEPHEN });
  assert.ok(fires(s, 'VERA-N03'));
  const j = evaluate({ ...CLEAN_ITEM, person: 'jasmine-amaso', body: 'Clean copy.' }, { factFile: JASMINE });
  assert.ok(fires(j, 'VERA-N03'));
  const jSigned = evaluate({ ...CLEAN_ITEM, person: 'jasmine-amaso', body: 'Clean copy.' },
    { factFile: { ...JASMINE, sign_off: { signed_off: true, signed_off_by: 'Jasmine Amaso', signed_off_at: '2026-07-11', state: 'publish_enabled_crawl' } } });
  assert.ok(!fires(jSigned, 'VERA-N03'));
});

test('VERA-N04 action outside the delegation grant blocks', () => {
  const v = ev(item('Congrats on the raise!', { kind: 'comment' }), { subjectCapabilities: ['post'] });
  assert.ok(fires(v, 'VERA-N04'));
  const ok = ev(item('Congrats to the team.', { kind: 'comment' }), { subjectCapabilities: ['post', 'comment'] });
  assert.ok(!fires(ok, 'VERA-N04'));
});

test('VERA-N05 third-party PII blocks; Centurion contact points pass', () => {
  assert.ok(fires(ev(item('Reach John at john.doe@gmail.com for details.')), 'VERA-N05'));
  assert.ok(fires(ev(item('Call him on 713-555-0142 today.')), 'VERA-N05'));
  assert.ok(!fires(ev(item('Write to info@centurionfinancial.com for mandates.')), 'VERA-N05'));
});

test('VERA-P01 engagement-pod language blocks', () => {
  assert.ok(fires(ev(item('Join our engagement pod for reach.')), 'VERA-P01'));
  assert.ok(fires(ev(item('Follow-for-follow to grow together.')), 'VERA-P01'));
});

test('VERA-P02 clickbait flags', () => {
  assert.ok(flagged(ev(item("You won't believe this financing structure.")), 'VERA-P02'));
});

test('VERA-P03 promotion without disclosure blocks; disclosure passes', () => {
  assert.ok(fires(ev(item('Big things coming from this platform.', { promotes: true })), 'VERA-P03'));
  assert.ok(!fires(ev(item('Big things from this client of Centurion.', { promotes: true })), 'VERA-P03'));
});

test('VERA-P04 solicitation language blocks', () => {
  assert.ok(fires(ev(item('Invest now - DM us to invest today.')), 'VERA-P04'));
});

test('VERA-P05 daily cap reached blocks the run', () => {
  assert.ok(fires(ev(item('Great point, congrats.', { kind: 'comment' }), { caps: { used: 25, cap: 25, action: 'comment' } }), 'VERA-P05'));
  assert.ok(!fires(ev(item('Great point, congrats.', { kind: 'comment' }), { caps: { used: 3, cap: 25 } }), 'VERA-P05'));
});

test('VERA-P06 duplicate engagement text blocks at the third repeat', () => {
  const body = 'Congrats on the close!';
  assert.ok(fires(ev(item(body, { kind: 'comment' }), { recentTexts: [body, body] }), 'VERA-P06'));
  assert.ok(!fires(ev(item(body, { kind: 'comment' }), { recentTexts: [body] }), 'VERA-P06'));
});

test('VERA-P07 hashtag stuffing flags on LinkedIn', () => {
  const v = ev(item('Growth. #cre #capital #lending #debt #equity #sponsors'));
  assert.ok(flagged(v, 'VERA-P07'));
});
