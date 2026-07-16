// Brand rules, DNS compilation, bounce JSON shape, gates, fact-file seeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, compileDnsRules } from '../src/engine.mjs';
import { RULESET_VERSION } from '../src/rules.mjs';
import { ASHTON, JASMINE, ANWAR, STEPHEN, item } from './fixtures.mjs';

const ev = (it, ctx = {}) => evaluate(it, { factFile: ASHTON, ...ctx });
const fires = (v, id) => v.rule_ids.includes(id);
const flagged = (v, id) => v.flag_ids.includes(id);

test('VERA-B01 hype lexicon flags (incl. rocket emoji)', () => {
  assert.ok(flagged(ev(item('We are crushing it this quarter 🚀')), 'VERA-B01'));
});

test('VERA-B02 promissory performance language blocks', () => {
  assert.ok(fires(ev(item('This structure will double your proceeds.')), 'VERA-B02'));
});

test('VERA-B03 disparagement flags', () => {
  assert.ok(flagged(ev(item('That lender is a scam operation.')), 'VERA-B03'));
});

test('VERA-B04 brand misspelling flags', () => {
  assert.ok(flagged(ev(item('Centurian Financial keeps winning.')), 'VERA-B04'));
});

test('VERA-B05 voice score is LLM-gated and skipped in deterministic P1', () => {
  const v = ev(item('Anything at all.'));
  assert.ok(v.skipped_rules.includes('VERA-B05'));
  assert.ok(!fires(v, 'VERA-B05') && !flagged(v, 'VERA-B05'));
});

test('VERA-DNS-* person do_not_say compiles into BLOCK rules and fires', () => {
  const dns = compileDnsRules(JASMINE);
  assert.equal(dns.length, 1);
  assert.equal(dns[0].id, 'VERA-DNS-jasmine-amaso-1');
  assert.equal(dns[0].severity, 'block');
  const v = evaluate(item('She raised $1.28B for the platform.', { person: 'jasmine-amaso' }), { factFile: JASMINE });
  assert.ok(fires(v, 'VERA-DNS-jasmine-amaso-1'));
  assert.ok(fires(v, 'VERA-T02')); // the global rule also catches, per the fact-file note
});

test('bounce JSON shape per SPEC-E section 4: rule ids, verbatim quotes, spans, one suggested_fix', () => {
  const it = item("We've raised $2B across mandates.", { id: 'q-test-0031' });
  const v = ev(it);
  assert.equal(v.verdict, 'bounce');
  assert.equal(v.item_id, 'q-test-0031');
  assert.equal(v.ruleset_version, RULESET_VERSION);
  assert.ok(v.rule_ids.includes('VERA-T02'));
  assert.ok(v.rule_ids.includes('VERA-T03'));
  assert.ok(v.quotes.length > 0);
  const text = it.body;
  for (const q of v.quotes) {
    assert.ok(q.rule_id && typeof q.quote === 'string');
    if (q.span) assert.equal(text.slice(q.span[0], q.span[1]), q.quote); // spans are verbatim
  }
  assert.equal(typeof v.suggested_fix, 'string'); // one actionable instruction
  assert.ok(v.checked_at);
  // class order precedence: first reported rule is term-class
  assert.ok(v.rule_ids[0].startsWith('VERA-T') || v.rule_ids[0].startsWith('VERA-DNS'));
});

test('pass verdict carries empty rule_ids/quotes and the four gate stamps', () => {
  const v = ev(item('A quiet, factual institutional update.'));
  assert.equal(v.verdict, 'pass');
  assert.deepEqual(v.rule_ids, []);
  assert.deepEqual(v.quotes, []);
  assert.deepEqual(v.gates.map((g) => g.gate), ['fact_base', 'brand_voice', 'legal_claims', 'platform_tos']);
});

test('flag-only hits pass but hold for human (SPEC-G hold_for_human)', () => {
  const v = ev(item('The leading platform for sponsors.'));
  assert.equal(v.verdict, 'pass');
  assert.equal(v.hold_for_human, true);
  assert.ok(v.flag_ids.includes('VERA-C09'));
  const gate = v.gates.find((g) => g.gate === 'fact_base');
  assert.equal(gate.ok, false); // the flag shows on its gate stamp
});

test('seed fact-files validate against the SPEC-E section 3 required fields', () => {
  const REQUIRED = ['person_id', 'name', 'role_title', 'bio_approved', 'verified_employers',
    'do_not_say', 'approved_claims', 'headshot', 'sign_off'];
  for (const ff of [ASHTON, JASMINE, STEPHEN, ANWAR]) {
    for (const k of REQUIRED) assert.ok(k in ff, `${ff.person_id} missing ${k}`);
    assert.ok(['draft_only', 'bio_submitted', 'signed_off', 'publish_enabled_crawl'].includes(ff.sign_off.state));
    assert.ok(['approved', 'pending', 'missing'].includes(ff.headshot.status));
    assert.equal(typeof ff.sign_off.signed_off, 'boolean');
  }
});
