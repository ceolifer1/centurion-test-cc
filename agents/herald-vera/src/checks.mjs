// Programmatic checks for the SPEC-E rule engine (the `check` XOR `pattern`
// half of the rule record). Each check is deterministic - NO model calls in
// P1 - and returns an array of hits: { quote, span }. `span` is [start,end)
// into the checked text, or null for non-textual conditions (consent state,
// caps, metadata). Unit-tested individually per SPEC-E 1.2.
import { MONEY_SRC } from './rules.mjs';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const money = () => new RegExp(MONEY_SRC + String.raw`\b`, 'gi');
const pct = () => /\b\d+(?:\.\d+)?\s*%/g;
const hit = (m) => ({ quote: m[0], span: [m.index, m.index + m[0].length] });
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const normFig = (s) => String(s ?? '').toLowerCase().replace(/[\s,]/g, '');

export function moneyValue(str) {
  const m = String(str).replace(/[$,\s]/g, '').toLowerCase();
  const num = parseFloat(m);
  if (Number.isNaN(num)) return 0;
  if (/(bn?|billion)$/.test(m)) return num * 1e9;
  if (/(mm|m|million)$/.test(m)) return num * 1e6;
  if (/(k|thousand)$/.test(m)) return num * 1e3;
  return num;
}

// Whitelist pool: global registry fact texts + the subject's approved_claims[]
// (SPEC-E 1.3: exact string or exact value - no rounding up).
function pool(ctx) {
  const out = [];
  for (const f of ctx.registry?.facts || []) if (f.text) out.push(f.text);
  for (const c of ctx.factFile?.approved_claims || []) if (c.text) out.push(c.text);
  return out;
}
const citationTokens = (ctx) =>
  (ctx.citations || []).map((c) => (typeof c === 'string' ? c : c?.fact_id || c?.approved_claim_id || '')).filter(Boolean);
const hasPipelineCitation = (ctx) => citationTokens(ctx).includes('leadcrm:pipeline_active_value');
const nearPipelineKeyword = (text, idx) => {
  const re = /\b(pipeline|deal[\s-]*flow)\b/gi;
  for (const k of text.matchAll(re)) {
    if (Math.abs(k.index - idx) <= 80 + k[0].length) return true;
  }
  return false;
};
// Band notation ("$5-15M", "$50M+") must not be treated as an exact figure:
// the money regex only captures the leading fragment of a band, so a token
// immediately followed by a dash-digit or a plus sign is band notation.
const isBandToken = (text, m) => /^([–—-]\s?\d|\+)/.test(text.slice(m.index + m[0].length));
const figureCovered = (text, m, ctx) => {
  const fig = normFig(m[0]);
  return pool(ctx).some((t) => normFig(t).includes(fig)) ||
    (hasPipelineCitation(ctx) && nearPipelineKeyword(text, m.index));
};

export const CHECKS = {
  // VERA-T04: two patterns - explicit 1999 forms, plus "founded <year != 2021>".
  founding_year(item, text) {
    const hits = [];
    for (const m of text.matchAll(/\b(founded|established|est\.?|since|founded\s+in)\s+(in\s+)?1999\b/gi)) hits.push(hit(m));
    for (const m of text.matchAll(/\bfounded\s+(?:in\s+)?(?!2021)\d{4}\b/gi)) hits.push(hit(m));
    return hits;
  },

  // VERA-C01: every $ figure / % must be whitelisted or covered by a citation.
  numeric_claim_whitelist(item, text, ctx) {
    const hits = [];
    for (const re of [money(), pct()]) {
      for (const m of text.matchAll(re)) {
        if (isBandToken(text, m)) continue; // band notation is VERA-N02's domain
        if (!figureCovered(text, m, ctx)) hits.push(hit(m));
      }
    }
    return hits;
  },

  // VERA-C02 (flag): count claims must match the whitelist.
  count_claim_whitelist(item, text, ctx) {
    const hits = [];
    const texts = pool(ctx).map(norm);
    for (const m of text.matchAll(/\b\d[\d,]*\+?\s+(transactions?|deals?|closings?|funders?|lenders?|clients?|countries|years)\b/gi)) {
      const phrase = norm(m[0].replace(/\+/g, ''));
      if (!texts.some((t) => t.replace(/\+/g, '').includes(phrase))) hits.push(hit(m));
    }
    return hits;
  },

  // VERA-C03: money >= $1B needs principals'-lifetime framing within +/-120
  // chars plus an advised/closed verb. Whitelisted figures (approved claims,
  // e.g. JA-02's "$1.28B+ term sheets") and pipeline-cited figures carry their
  // own approved framing and are exempt - otherwise VERA-C03 would contradict
  // the whitelist it shares with VERA-C01.
  lifetime_framing(item, text, ctx) {
    const hits = [];
    for (const m of text.matchAll(money())) {
      if (isBandToken(text, m) || moneyValue(m[0]) < 1e9) continue;
      if (figureCovered(text, m, ctx)) continue;
      const w = text.slice(Math.max(0, m.index - 120), m.index + m[0].length + 120);
      const framed = /\bprincipals'?(\s+lifetime)?\b|across\s+our\s+principals/i.test(w) && /\b(advised|closed)\b/i.test(w);
      if (!framed) hits.push(hit(m));
    }
    return hits;
  },

  // VERA-C04: pipeline/deal-flow near a money amount requires the live-query citation.
  pipeline_headline(item, text, ctx) {
    const hits = [];
    if (hasPipelineCitation(ctx)) return hits;
    for (const k of text.matchAll(/\b(pipeline|deal[\s-]*flow)\b/gi)) {
      for (const m of text.matchAll(money())) {
        if (Math.abs(m.index - k.index) <= 80 + k[0].length) { hits.push(hit(k)); break; }
      }
    }
    return hits;
  },

  // VERA-C05: org names in work-history contexts must be in verified_employers[].
  employer_claims(item, text, ctx) {
    const hits = [];
    const verified = (ctx.factFile?.verified_employers || []).filter((e) => e.verified).map((e) => norm(e.org));
    const TITLE_STOP = new Set(['president', 'ceo', 'coo', 'cfo', 'cto', 'founder', 'head', 'director',
      'vp', 'chairman', 'partner', 'managing', 'officer', 'underwriter', 'chief']);
    const ORG = String.raw`([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*)`;
    const res = [
      new RegExp(String.raw`\bworked\s+(?:at|for|with)\s+` + ORG, 'g'),
      new RegExp(String.raw`\bformer(?:ly)?\s+(?:at\s+)?` + ORG, 'g'),
      new RegExp(String.raw`\bex-` + ORG, 'g'),
      new RegExp(String.raw`\bdelivered\s+[^.]{0,40}?\bto\s+` + ORG, 'g'),
    ];
    for (const re of res) {
      for (const m of text.matchAll(re)) {
        const org = norm(m[1]);
        if (TITLE_STOP.has(org.split(' ')[0])) continue;
        const ok = verified.some((v) => v.includes(org) || org.includes(v.replace(/\s*\(.*$/, '')));
        if (!ok) hits.push({ quote: m[1], span: [m.index, m.index + m[0].length] });
      }
    }
    return hits;
  },

  // VERA-C06: degree/school mentions must match education[] (TODO entries do
  // not count - Ashton's education is unverified, so any claim for him blocks).
  education_claims(item, text, ctx) {
    const signal = /\b(university|college|degree)\b/i.test(text) ||
      /\b(?:B\.?A\.?|B\.?S\.?|M\.?S\.?|MBA|Ph\.?D\.?)\b/.test(text);
    if (!signal) return [];
    const entries = (ctx.factFile?.education || []).filter((e) => e.school && !/^\s*TODO/i.test(e.school));
    const schools = [
      ...text.matchAll(/\b([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*\s+(?:University|College|Institute))\b/g),
      ...text.matchAll(/\b((?:University|College)\s+of\s+[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)\b/g),
    ];
    const hits = [];
    if (!entries.length) {
      // no verified education: the first education signal in the text blocks
      const m = text.match(/\b(university|college|degree|B\.?A\.?|B\.?S\.?|M\.?S\.?|MBA|Ph\.?D\.?)\b/i);
      return [m ? { quote: m[0], span: [m.index, m.index + m[0].length] } : { quote: 'education claim', span: null }];
    }
    for (const s of schools) {
      const ok = entries.some((e) => norm(s[1]).includes(norm(e.school)) || norm(e.school).includes(norm(s[1])));
      if (!ok) hits.push({ quote: s[1], span: [s.index, s.index + s[0].length] });
    }
    return hits;
  },

  // VERA-C07: "Name, Title" / "Name - Title" pairs must match role_title.
  title_claims(item, text, ctx) {
    const hits = [];
    const people = [];
    if (ctx.factFiles) for (const p of Object.values(ctx.factFiles)) people.push(p);
    if (ctx.factFile && !people.includes(ctx.factFile)) people.push(ctx.factFile);
    const normTitle = (s) => norm(String(s).replace(/[·•–—-]/g, ' '));
    for (const p of people) {
      if (!p?.name || !p?.role_title) continue;
      const re = new RegExp(esc(p.name) + String.raw`\s*[,–—-]\s*([A-Z][^,.\n;]{2,60})`, 'g');
      for (const m of text.matchAll(re)) {
        const a = normTitle(m[1]); const b = normTitle(p.role_title);
        if (!(a === b || a.includes(b) || b.includes(a))) hits.push({ quote: m[0], span: [m.index, m.index + m[0].length] });
      }
    }
    return hits;
  },

  // VERA-C08: Powered Labs mention allowed only as the approved one-liner.
  powered_labs_one_liner(item, text) {
    const ms = [...text.matchAll(/\bPowered\s+Labs\b/gi)];
    if (!ms.length) return [];
    if (ms.length > 1) return ms.map(hit);
    const m = ms[0];
    const start = text.lastIndexOf('.', m.index) + 1;
    const dot = text.indexOf('.', m.index + m[0].length);
    const sentence = text.slice(start, dot === -1 ? text.length : dot + 1);
    const ok = /2010/.test(sentence) && /2018/.test(sentence) && /exit/i.test(sentence);
    return ok ? [] : [hit(m)];
  },

  // VERA-C10: real dates only. (a) no backdating; (b) event dates must equal
  // the system-of-record date supplied by the caller (LeadCRM close/hire date).
  real_dates(item, text, ctx) {
    const hits = [];
    if (item.backdate_requested === true) hits.push({ quote: 'backdate_requested', span: null });
    if (item.published_at) {
      const p = new Date(item.published_at);
      const now = ctx.now ? new Date(ctx.now) : new Date();
      if (!Number.isNaN(+p) && now - p > 15 * 60 * 1000) hits.push({ quote: String(item.published_at), span: null });
    }
    if (item.event_date && ctx.systemOfRecordDate &&
        String(item.event_date).slice(0, 10) !== String(ctx.systemOfRecordDate).slice(0, 10)) {
      hits.push({ quote: String(item.event_date), span: null });
    }
    return hits;
  },

  // VERA-N01: named clients require per-deal client_name_consent = TRUE.
  // ctx.clients is the caller-supplied slice of the LeadCRM client registry.
  client_naming(item, text, ctx) {
    const hits = [];
    for (const c of ctx.clients || []) {
      if (!c?.name || c.client_name_consent === true) continue;
      for (const m of text.matchAll(new RegExp(String.raw`\b` + esc(c.name) + String.raw`\b`, 'gi'))) hits.push(hit(m));
    }
    return hits;
  },

  // VERA-N02: exact deal amounts need consent; otherwise size bands only.
  size_banding(item, text, ctx) {
    const noConsentDeal = ctx.deal && ctx.deal.client_name_consent === false;
    const namedNoConsent = (ctx.clients || []).some((c) => c?.name && c.client_name_consent !== true &&
      new RegExp(String.raw`\b` + esc(c.name) + String.raw`\b`, 'i').test(text));
    if (!noConsentDeal && !namedNoConsent) return [];
    const hits = [];
    for (const m of text.matchAll(money())) {
      if (!isBandToken(text, m)) hits.push(hit(m));
    }
    return hits;
  },

  // VERA-N03 (hard gate, alias VERA-G01): the person the item publishes FOR
  // must be signed off. Per SPEC-E 3.2 note, a fact-file counts as signed off
  // only once signed_off_by/at are actually filled (not TODO).
  subject_signed_off(item, text, ctx) {
    const so = ctx.factFile?.sign_off;
    const filled = (v) => v != null && String(v).trim() !== '' && !/^\s*TODO/i.test(String(v));
    const ok = so?.signed_off === true &&
      ['signed_off', 'publish_enabled_crawl'].includes(so?.state) &&
      filled(so?.signed_off_by) && filled(so?.signed_off_at);
    return ok ? [] : [{ quote: item.person || ctx.factFile?.person_id || 'unknown-person', span: null }];
  },

  // VERA-N04: the action must be inside the subject's delegation grant.
  // Evaluable only when the caller supplies the subject's capability slice
  // (engagement runs do); absent context = not evaluable, no hit.
  delegation_capability(item, text, ctx) {
    if (!Array.isArray(ctx.subjectCapabilities)) return [];
    const action = ctx.action || item.kind || 'post';
    return ctx.subjectCapabilities.includes(action)
      ? [] : [{ quote: action, span: null }];
  },

  // VERA-N05: third-party PII (emails, phone numbers). Allowlist: published
  // Centurion contact points + caller-supplied ctx.piiAllowlist.
  third_party_pii(item, text, ctx) {
    const hits = [];
    const allowed = (s) => /@centurionfinancial\.com$/i.test(s) ||
      (ctx.piiAllowlist || []).some((a) => s.toLowerCase().includes(String(a).toLowerCase()));
    for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) if (!allowed(m[0])) hits.push(hit(m));
    for (const m of text.matchAll(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g)) {
      const digits = m[0].replace(/\D/g, '');
      const ok = (ctx.piiAllowlist || []).some((a) => String(a).replace(/\D/g, '') === digits);
      if (!ok) hits.push(hit(m));
    }
    return hits;
  },

  // VERA-P03: promotions of paying clients/placements need a disclosure token.
  promo_disclosure(item, text, ctx) {
    if (!(item.promotes === true || ctx.promotion === true)) return [];
    if (/#ad\b|client\s+of\s+centurion|we\s+advise\b/i.test(text)) return [];
    return [{ quote: 'promotion without disclosure token', span: null }];
  },

  // VERA-P05: behavioral - a run that would exceed the daily cap STOPS.
  rate_caps(item, text, ctx) {
    const c = ctx.caps;
    if (!c || typeof c.used !== 'number' || typeof c.cap !== 'number') return [];
    return c.used >= c.cap
      ? [{ quote: `daily cap reached (${c.used}/${c.cap}${c.action ? ' ' + c.action : ''})`, span: null }] : [];
  },

  // VERA-P06: normalized text repeated > 2x within 7 days (caller supplies the
  // person's recent normalized texts).
  duplicate_content(item, text, ctx) {
    const n = norm(text);
    const count = (ctx.recentTexts || []).filter((t) => norm(t) === n).length;
    return count >= 2 ? [{ quote: text.slice(0, 60), span: [0, Math.min(60, text.length)] }] : [];
  },

  // VERA-P07 (flag): > 5 hashtags (LinkedIn) or > 3 @-mentions.
  stuffing(item, text) {
    const hits = [];
    const tags = text.match(/#\w+/g) || [];
    const mentions = text.match(/(?<=^|[\s(,;:])@[A-Za-z]\w*/g) || [];
    if (String(item.platform || '').startsWith('linkedin') && tags.length > 5) {
      hits.push({ quote: tags.slice(0, 8).join(' '), span: null });
    }
    if (mentions.length > 3) hits.push({ quote: mentions.slice(0, 6).join(' '), span: null });
    return hits;
  },

  // VERA-B03 (flag): deterministic disparagement lexicon. The model-scored
  // sensitive-topics half rides the LLM flag (OFF in P1).
  sensitive_topics(item, text) {
    return [...text.matchAll(/\b(scam|fraud(?:ulent)?|crooks?)\b/gi)].map(hit);
  },

  // VERA-B05: model-scored voice comparison - LLM-only, behind the flag
  // (engine skips llm-marked rules when LLM_BRAND_PASS is off).
  voice_score() {
    return [];
  },
};
