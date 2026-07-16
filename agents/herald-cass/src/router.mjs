// Optional model assist for theme IDEATION only (never for the schedule itself -
// the calendar is deterministic). Mirrors the cf-mandate-ops / Nico two-tier
// router: Sonnet by default, Opus for a large theme brief. This is the only path
// in Cass that spends model tokens, so it feeds the ledger + the engine-wide
// $400 gate exactly like Nico. Injected fetch keeps unit tests off the network.
import { MODEL_DEFAULT, MODEL_ESCALATION, MODEL_IDS, MODEL_PRICE } from './config.mjs';

const HARD_BRIEF_CHARS = 900;

export function pickModel({ brief = '', hard = false } = {}) {
  return (hard || String(brief).length > HARD_BRIEF_CHARS) ? MODEL_ESCALATION : MODEL_DEFAULT;
}

export function costCentsFor(model, usage = {}) {
  const [pin, pout] = MODEL_PRICE[model] || MODEL_PRICE[MODEL_DEFAULT];
  const usd = (Number(usage.input_tokens || 0) / 1e6) * pin + (Number(usage.output_tokens || 0) / 1e6) * pout;
  return Math.round(usd * 100);
}

export async function callModel({ model, system, user, anthropicKey, maxTokens = 600, fetchImpl = fetch }) {
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

// Ideation system prompt: return a JSON array of short theme strings, grounded
// in the fact-file. Cass parses it; on any parse failure it falls back to the
// deterministic default themes (ideation is never load-bearing).
export function ideationPrompt({ person, factFile, count = 6 }) {
  const name = factFile?.name || person;
  const claims = (factFile?.approved_claims || []).map((c) => `- ${c.text}`).join('\n') || '- (none on file)';
  return [
    `You are Cass, the content strategist for Centurion Financial's presence engine.`,
    `Propose ${count} short content THEMES (3-6 words each) for ${name}, suitable for an institutional finance audience.`,
    `Ground every theme in the approved facts below. No promissory or forward-looking claims. No AUM/"raised" framing.`,
    ``,
    `Approved facts:`,
    claims,
    ``,
    `Output ONLY a JSON array of theme strings, e.g. ["market structure", "capital formation"]. No prose.`,
  ].join('\n');
}

export function parseThemes(text) {
  try {
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return null;
    const arr = JSON.parse(m[0]);
    const clean = (Array.isArray(arr) ? arr : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
    return clean.length ? clean : null;
  } catch { return null; }
}
