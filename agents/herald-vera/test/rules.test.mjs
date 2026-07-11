// Every BLOCK rule fires on a crafted sample and stays quiet on clean copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/engine.mjs';
import { RULES } from '../src/rules.mjs';
import { ASHTON, JASMINE, CLEAN_ITEM, item } from './fixtures.mjs';

const ev = (it, ctx = {}) => evaluate(it, { factFile: ASHTON, ...ctx });
const fires = (v, id) => v.rule_ids.includes(id);
const flagged = (v, id) => v.flag_ids.includes(id);

test('rule table has exactly 35 rules with the spec class split', () => {
  assert.equal(RULES.length, 35);
  const byCls = {};
  for (const r of RULES) byCls[r.cls] = (byCls[r.cls] || 0) + 1;
  assert.deepEqual(byCls, { term: 8, claim: 10, consent: 5, platform: 7, brand: 5 });
});

test('clean Ashton copy passes with all four gates ok', () => {
  const v = ev(CLEAN_ITEM);
  assert.equal(v.verdict, 'pass');
  assert.deepEqual(v.rule_ids, []);
  assert.deepEqual(v.quotes, []);
  assert.equal(v.hold_for_human, false);
  assert.equal(v.gates.length, 4);
  assert.ok(v.gates.every((g) => g.ok));
});

test('VERA-T01 AUM blocks', () => {
  const v = ev(item('Our AUM keeps growing across the platform.'));
  assert.equal(v.verdict, 'bounce');
  assert.ok(fires(v, 'VERA-T01'));
});

test('VERA-T02 raised-$ blocks', () => {
  assert.ok(fires(ev(item("We've raised $5M this quarter for sponsors.")), 'VERA-T02'));
  assert.ok(fires(ev(item('Raising over $40 million right now.')), 'VERA-T02'));
});

test('VERA-T03 $2B blocks', () => {
  assert.ok(fires(ev(item('A $2B track record.')), 'VERA-T03'));
  assert.ok(fires(ev(item('$ 2 billion advised.')), 'VERA-T03'));
});

test('VERA-T04 wrong founding year blocks, founded 2021 passes', () => {
  assert.ok(fires(ev(item('Centurion Financial, founded in 1999, serves sponsors.')), 'VERA-T04'));
  assert.ok(fires(ev(item('Founded 2019 and growing.')), 'VERA-T04'));
  assert.ok(!fires(ev(item('Centurion Financial (founded 2021).')), 'VERA-T04'));
});

test('VERA-T05 Sum Capital blocks', () => {
  assert.ok(fires(ev(item('Our partner Sum Capital joins the JV.')), 'VERA-T05'));
});

test('VERA-T06 closed capital blocks', () => {
  assert.ok(fires(ev(item('Closed capital across four mandates.')), 'VERA-T06'));
});

test('VERA-T07 Head Underwriter blocks', () => {
  assert.ok(fires(ev(item('Meet our Head Underwriter.')), 'VERA-T07'));
});

test('VERA-T08 guarantee language blocks', () => {
  assert.ok(fires(ev(item('Guaranteed funding for qualified sponsors.')), 'VERA-T08'));
  assert.ok(fires(ev(item('A risk-free path to closing.')), 'VERA-T08'));
});

test('VERA-C01 unmatched $ figure blocks; whitelisted figure passes', () => {
  assert.ok(fires(ev(item('We advised on $37.5M for a Gulf sponsor.')), 'VERA-C01'));
  const v = evaluate(item('$1.28B+ in lender and investor term sheets across UAE real estate.', { person: 'jasmine-amaso' }), { factFile: JASMINE });
  assert.ok(!fires(v, 'VERA-C01'));
});

test('VERA-C01 unmatched percent blocks', () => {
  assert.ok(fires(ev(item('Our clients see 37% faster closings.')), 'VERA-C01'));
});

test('VERA-C02 count claim off the whitelist flags; approved count passes', () => {
  const v = ev(item('Our team closed 500 deals last year.'));
  assert.ok(flagged(v, 'VERA-C02'));
  const ok = ev(item('28 years across software, banking technology, and commercial finance.'));
  assert.ok(!flagged(ok, 'VERA-C02'));
});

test('VERA-C03 unframed >= $1B aggregate blocks; principals framing clears C03', () => {
  const bad = ev(item('We have completed $13B in transactions.'));
  assert.ok(fires(bad, 'VERA-C03'));
  const good = ev(item("Our principals have advised and closed transactions exceeding $13B across our principals' lifetime."));
  assert.ok(!fires(good, 'VERA-C03')); // C01 still owns the uncited figure
  assert.ok(fires(good, 'VERA-C01'));
});

test('VERA-C04 pipeline headline needs the live-query citation', () => {
  assert.ok(fires(ev(item('Our current pipeline stands at $4.75B.')), 'VERA-C04'));
  const cited = ev(item('Our current pipeline stands at $4.75B.', { citations: ['leadcrm:pipeline_active_value'] }));
  assert.ok(!fires(cited, 'VERA-C04'));
  assert.ok(!fires(cited, 'VERA-C01')); // pipeline-cited figure is covered
  assert.ok(!fires(cited, 'VERA-C03'));
});

test('VERA-C05 unverified employer blocks; verified employer passes', () => {
  assert.ok(fires(ev(item('Earlier he worked at Google on payments.')), 'VERA-C05'));
  assert.ok(!fires(ev(item('He delivered systems to Microsoft over a decade.')), 'VERA-C05'));
});

test('VERA-C06 education claim blocks for Ashton (TODO fact base), passes for Jasmine', () => {
  assert.ok(fires(ev(item('He holds a degree from Harvard University.')), 'VERA-C06'));
  const v = evaluate(item('She earned her M.S. at Columbia University.', { person: 'jasmine-amaso' }), { factFile: JASMINE });
  assert.ok(!fires(v, 'VERA-C06'));
});

test('VERA-C07 wrong title blocks; approved title passes', () => {
  assert.ok(fires(ev(item('Ashton Couture - Chief Investment Officer of Centurion.')), 'VERA-C07'));
  assert.ok(!fires(ev(item('Ashton Couture, Founder & CEO, will speak Friday.')), 'VERA-C07'));
});

test('VERA-C08 Powered Labs beyond the one-liner blocks; the one-liner passes', () => {
  assert.ok(fires(ev(item('Powered Labs was an incredible ride. Powered Labs changed everything.')), 'VERA-C08'));
  assert.ok(fires(ev(item('Powered Labs grew to 200 people before we sold it.')), 'VERA-C08'));
  assert.ok(!fires(ev(item('Powered Labs (2010-2018, exited).')), 'VERA-C08'));
});

test('VERA-C09 superlatives flag', () => {
  assert.ok(flagged(ev(item('The leading advisory shop in Texas.')), 'VERA-C09'));
});

test('VERA-C10 backdating blocks', () => {
  assert.ok(fires(ev(item('A look back at our year.', { backdate_requested: true })), 'VERA-C10'));
  const v = ev(item('Dated announcement.', { published_at: '2026-07-01T00:00:00Z' }), { now: '2026-07-11T00:00:00Z' });
  assert.ok(fires(v, 'VERA-C10'));
  const mismatch = ev(item('Deal closed.', { event_date: '2026-07-01' }), { systemOfRecordDate: '2026-06-15' });
  assert.ok(fires(mismatch, 'VERA-C10'));
});
