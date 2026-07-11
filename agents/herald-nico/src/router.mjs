// Model router - mirrors the cf-mandate-ops two-tier router: Sonnet by default,
// Opus for hard cases (long/complex briefs, deal-tombstone copy, or a redraft
// after a Vera bounce where the first pass already failed). The Anthropic key is
// herald/nico/anthropic-key (the engine-wide cios-herald cap key). This is the
// ONE place in HERALD Stage 2 that spends model tokens - Vera and Piper are
// deterministic. Token usage feeds the ledger + the engine-wide $400 gate.
import { MODEL_DEFAULT, MODEL_ESCALATION, MODEL_IDS, MODEL_PRICE } from './config.mjs';

const HARD_BRIEF_CHARS = 900;
const HARD_KINDS = new Set(['tombstone', 'thread']);

// Decide the tier. Explicit payload.hard or a redraft (retry) forces escalation
// - the cheap model already produced copy that bounced, so climb.
export function pickModel({ brief = '', kind = 'post', hard = false, isRedraft = false } = {}) {
  const complex = hard || isRedraft || HARD_KINDS.has(kind) || String(brief).length > HARD_BRIEF_CHARS;
  return complex ? MODEL_ESCALATION : MODEL_DEFAULT;
}

export function costCentsFor(model, usage = {}) {
  const [pin, pout] = MODEL_PRICE[model] || MODEL_PRICE[MODEL_DEFAULT];
  const inTok = Number(usage.input_tokens || 0);
  const outTok = Number(usage.output_tokens || 0);
  const usd = (inTok / 1e6) * pin + (outTok / 1e6) * pout;
  return Math.round(usd * 100);
}

// callModel: POST to the Anthropic Messages API. Returns { text, model, usage,
// costCents }. Injected fetch keeps unit tests off the network (mock at the
// boundary). Never logs the key or the full prompt (SPEC-C T3 log discipline).
export async function callModel({ model, system, user, anthropicKey, maxTokens = 1024, fetchImpl = fetch }) {
  const modelId = MODEL_IDS[model] || model;
  const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`anthropic ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const usage = data.usage || { input_tokens: 0, output_tokens: 0 };
  return { text, model, usage, costCents: costCentsFor(model, usage) };
}

// The house system prompt. Nico writes to the fact-file, never past it - Vera is
// the gate, but Nico should try to pass her the first time (cheaper than a
// bounce+redraft). Keep claims to approved_claims; no numbers Vera forbids.
export function systemPromptFor({ person, factFile, platform }) {
  const name = factFile?.name || person;
  const claims = (factFile?.approved_claims || []).map((c) => `- ${c.text}`).join('\n') || '- (no approved claims on file - stay generic and non-numeric)';
  const donot = (factFile?.do_not_say || []).map((d) => `- ${d.term}`).join('\n') || '- (none listed)';
  const bio = factFile?.approved_bio || '';
  return [
    `You are Nico, the content writer for Centurion Financial's presence engine.`,
    `You are drafting a ${platform} post for ${name}.`,
    `Write in a confident, factual, non-promissory institutional voice. No hype, no emojis-as-drama, no promissory or forward-looking financial claims.`,
    `You may ONLY use facts from the approved list below. Never state AUM, "raised $X", or any number not explicitly approved.`,
    ``,
    `Approved bio: ${bio}`,
    ``,
    `Approved claims (the only claims you may make):`,
    claims,
    ``,
    `Never say (hard blocks):`,
    donot,
    ``,
    `Output ONLY the post body text. No preamble, no hashtags unless the brief asks, no quotation marks around the whole thing.`,
  ].join('\n');
}
