// Model router for manage_company_page drafting - mirrors the cf-mandate-ops /
// herald-nico two-tier router (Sonnet default, Opus for hard cases). This is the
// ONLY place Gia spends model tokens (engage + enqueue_follow are deterministic).
// The Anthropic key is herald/gia/anthropic-key (the engine-wide cios-herald cap
// key). Token usage feeds the ledger + the engine-wide $400 gate. When the caller
// supplies a ready draft (payload.body) no model call happens at all.
import { MODEL_DEFAULT, MODEL_ESCALATION, MODEL_IDS, MODEL_PRICE } from './config.mjs';

const HARD_BRIEF_CHARS = 900;

export function pickModel({ brief = '', hard = false } = {}) {
  return (hard || String(brief).length > HARD_BRIEF_CHARS) ? MODEL_ESCALATION : MODEL_DEFAULT;
}

export function costCentsFor(model, usage = {}) {
  const [pin, pout] = MODEL_PRICE[model] || MODEL_PRICE[MODEL_DEFAULT];
  const inTok = Number(usage.input_tokens || 0);
  const outTok = Number(usage.output_tokens || 0);
  const usd = (inTok / 1e6) * pin + (outTok / 1e6) * pout;
  return Math.round(usd * 100);
}

// callModel: POST to the Anthropic Messages API. Injected fetch keeps unit tests
// off the network. Never logs the key or the full prompt (SPEC-C T3 discipline).
export async function callModel({ model, system, user, anthropicKey, maxTokens = 1024, fetchImpl = fetch }) {
  const modelId = MODEL_IDS[model] || model;
  const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modelId, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
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

// The house system prompt for a Centurion Financial COMPANY-PAGE post. Same
// factual, non-promissory institutional voice as Nico; claims restricted to the
// page-admin's approved fact-file (Vera gates the output regardless).
export function companyPagePrompt({ person, factFile }) {
  const name = factFile?.name || person;
  const claims = (factFile?.approved_claims || []).map((c) => `- ${c.text}`).join('\n') || '- (no approved claims on file - stay generic and non-numeric)';
  const donot = (factFile?.do_not_say || []).map((d) => `- ${d.term}`).join('\n') || '- (none listed)';
  return [
    `You are Gia, drafting a Centurion Financial LinkedIn COMPANY-PAGE post (page admin: ${name}).`,
    `Write in a confident, factual, non-promissory institutional voice. No hype, no emojis-as-drama, no promissory or forward-looking financial claims.`,
    `You may ONLY use facts from the approved list below. Never state AUM, "raised $X", or any number not explicitly approved.`,
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
