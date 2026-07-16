// SPEC-E rule engine: five ordered classes, no short-circuit (a bounce reports
// ALL hits so the writer fixes everything in one pass). Class order defines
// precedence for suggested_fix and reporting. Every verdict carries
// ruleset_version so historical verdicts stay reproducible.
import { RULES, RULESET_VERSION } from './rules.mjs';
import { CHECKS } from './checks.mjs';
import { FACT_REGISTRY } from './registry.mjs';

const CLASS_ORDER = { term: 1, claim: 2, consent: 3, platform: 4, brand: 5 };
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Fact-file do_not_say[] entries compile into person-scoped term-class BLOCK
// rules (SPEC-E 1.2: id = VERA-DNS-<person>-<n>).
export function compileDnsRules(factFile) {
  const out = [];
  (factFile?.do_not_say || []).forEach((d, i) => {
    if (!d?.term && !d?.pattern) return;
    let src = d.pattern;
    if (!src) {
      const body = escRe(d.term);
      src = (/^\w/.test(d.term) ? '\\b' : '') + body + (/\w$/.test(d.term) ? '\\b' : '');
    }
    out.push({
      id: `VERA-DNS-${factFile.person_id || 'person'}-${i + 1}`,
      cls: 'term', severity: 'block', pattern: src, flags: 'gi',
      message: `Person-specific do-not-say: "${d.term}"${d.reason ? ` (${d.reason})` : ''}`,
      fix: 'Remove or rephrase per the fact-file.',
    });
  });
  return out;
}

const appliesTo = (rule, item) => {
  if (!rule.applies || rule.applies.includes('*')) return true;
  return !item.kind || rule.applies.includes(item.kind);
};

const dedupe = (hits) => {
  const seen = new Set(); const out = [];
  for (const h of hits) {
    const k = `${h.quote}|${h.span ? h.span.join(':') : 'x'}`;
    if (!seen.has(k)) { seen.add(k); out.push(h); }
  }
  return out;
};

function buildGates(entries) {
  const idsFor = (clses) => entries.filter((e) => clses.includes(e.rule.cls)).map((e) => e.rule.id);
  const mk = (gate, clses) => {
    const ids = idsFor(clses);
    return { gate, ok: ids.length === 0, note: ids.length ? `hit: ${[...new Set(ids)].join(', ')}` : 'clear' };
  };
  return [
    mk('fact_base', ['claim']),
    mk('brand_voice', ['brand']),
    mk('legal_claims', ['term', 'consent']),
    mk('platform_tos', ['platform']),
  ];
}

// item: { id?, person, platform, kind, title?, body, media_text?, citations?,
//         published_at?, event_date?, backdate_requested?, promotes? }
// ctx:  { factFile, factFiles?, registry?, clients?, deal?, subjectCapabilities?,
//         action?, caps?, recentTexts?, piiAllowlist?, systemOfRecordDate?,
//         llmBrandPass?, now? }
// Returns the SPEC-E section 4 verdict object (superset: gates + flags +
// hold_for_human for the SPEC-G vera_verdict rendering).
export function evaluate(item, ctx = {}) {
  const c = {
    ...ctx,
    registry: ctx.registry || FACT_REGISTRY,
    citations: item.citations || ctx.citations || [],
  };
  const text = [item.title, item.body, ...(item.media_text ? [].concat(item.media_text) : [])]
    .filter(Boolean).join('\n');
  const rules = [...RULES, ...compileDnsRules(c.factFile)];
  const blocks = []; const flags = []; const skipped = [];

  for (const r of rules) {
    if (r.llm && !c.llmBrandPass) { skipped.push(r.id); continue; }
    if (!appliesTo(r, item)) continue;
    let hits = [];
    if (r.check) {
      const fn = CHECKS[r.check];
      hits = fn ? fn(item, text, c, r) : [];
    } else if (r.pattern) {
      for (const m of text.matchAll(new RegExp(r.pattern, r.flags || 'gi'))) {
        hits.push({ quote: m[0], span: [m.index, m.index + m[0].length] });
      }
    }
    if (!hits.length) continue;
    (r.severity === 'block' ? blocks : flags).push({ rule: r, hits: dedupe(hits) });
  }

  blocks.sort((a, b) => CLASS_ORDER[a.rule.cls] - CLASS_ORDER[b.rule.cls]);
  flags.sort((a, b) => CLASS_ORDER[a.rule.cls] - CLASS_ORDER[b.rule.cls]);

  const toQuotes = (entries) => entries.flatMap((e) =>
    e.hits.map((h) => ({ rule_id: e.rule.id, quote: h.quote, span: h.span })));

  const verdict = blocks.length ? 'bounce' : 'pass';
  return {
    verdict,
    item_id: item.id || null,
    ruleset_version: RULESET_VERSION,
    rule_ids: [...new Set(blocks.map((e) => e.rule.id))],
    quotes: toQuotes(blocks),
    flag_ids: [...new Set(flags.map((e) => e.rule.id))],
    flag_quotes: toQuotes(flags),
    suggested_fix: blocks.length ? blocks[0].rule.fix : (flags.length ? flags[0].rule.fix : null),
    hold_for_human: verdict === 'pass' && flags.length > 0,
    skipped_rules: skipped,
    gates: buildGates([...blocks, ...flags]),
    checked_at: (ctx.now ? new Date(ctx.now) : new Date()).toISOString(),
  };
}

export { RULESET_VERSION };
