// Peer edge Gia -> Vera (SPEC-H section 4). Gia's only outbound edge: it invokes
// Vera's Lambda directly (lambda:InvokeFunction, granted by invoke_peers = ["vera"]
// in infra/envs/herald-gia). Vera's handler accepts a direct (non-HTTP) event as
// the envelope and proves the caller by IAM + ALLOWED_CALLERS (chain last element
// = 'gia') - no JWT on peer calls (SPEC-B 7.2 rule 4). @aws-sdk/client-lambda ships
// in the nodejs20.x runtime, imported lazily so tests never touch AWS (mock via
// deps.callVera). Gia routes BOTH engagement-comment copy and company-page drafts
// through Vera's review_content before either is publishable.
import { REGION, VERA_FUNCTION } from './config.mjs';

// Send a review_content request to Vera and normalize her response envelope.
// Returns { verdict: 'pass'|'bounce', vera: <SPEC-G vera_verdict>, raw }.
export async function callVera({ runId, parentRunId, content, context, region = REGION, invokeImpl } = {}) {
  const envelope = {
    runId,
    mode: 'task',
    task: 'review_content',
    actor: { userId: 'agent:gia' },
    payload: { content, ...(context ? { context } : {}) },
    trace: { chain: ['gia'], parentRunId: parentRunId || null },
  };
  const invoke = invokeImpl || (await defaultInvoke(region));
  const raw = await invoke(envelope);
  return normalize(raw);
}

async function defaultInvoke(region) {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const client = new LambdaClient({ region });
  return async (envelope) => {
    const res = await client.send(new InvokeCommand({
      FunctionName: VERA_FUNCTION,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(envelope)),
    }));
    const txt = Buffer.from(res.Payload || []).toString('utf8') || '{}';
    if (res.FunctionError) throw new Error(`vera invoke error: ${txt.slice(0, 200)}`);
    return JSON.parse(txt);
  };
}

// Vera responds (SPEC-B 7.3) with { status, verdict, artifacts:[{type:'vera_verdict', data:v}] }.
function normalize(raw) {
  const status = raw?.status || 'error';
  if (status === 'killed' || status === 'refused') {
    return { verdict: 'bounce', blocked: true, status, vera: refusalVerdict(raw), raw };
  }
  const v = (raw?.artifacts || []).find((a) => a?.type === 'vera_verdict')?.data || null;
  const verdict = raw?.verdict || v?.verdict || 'bounce';
  return { verdict, status, vera: shapeVerdict(v, verdict), raw };
}

function shapeVerdict(v, verdict) {
  return {
    verdict,
    at: v?.checked_at || new Date().toISOString(),
    gates: v?.gates || [],
    bounce_reasons: (v?.quotes || []).map((q) => `${q.rule_id}: "${q.quote}"`),
    suggested_rewrite: v?.suggested_fix || null,
    model: 'deterministic',
    version: v?.ruleset_version ?? null,
    rule_ids: v?.rule_ids || [],
    hold_for_human: !!v?.hold_for_human,
  };
}

function refusalVerdict(raw) {
  return {
    verdict: 'bounce', at: new Date().toISOString(), gates: [],
    bounce_reasons: [`vera ${raw?.status}: ${raw?.reply || raw?.error || 'refused'}`],
    suggested_rewrite: null, model: 'deterministic', version: null, rule_ids: [], hold_for_human: false,
  };
}
