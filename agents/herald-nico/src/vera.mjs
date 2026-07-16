// Peer edge Nico -> Vera (SPEC-H section 4). Nico is the first agent to hold an
// outbound edge; it invokes Vera's Lambda directly (lambda:InvokeFunction, the
// IAM edge granted by invoke_peers = ["vera"] in infra/envs/herald-nico). Vera's
// handler accepts a direct (non-HTTP) event as the envelope and proves the
// caller by IAM + ALLOWED_CALLERS (chain last element = 'nico') - no JWT on peer
// calls (SPEC-B 7.2 rule 4). @aws-sdk/client-lambda ships in the nodejs20.x
// runtime, imported lazily so tests never touch AWS (mock via deps.callVera).
import { REGION, VERA_FUNCTION } from './config.mjs';

// Send a review_content request to Vera and normalize her response envelope.
// Returns { verdict: 'pass'|'bounce', vera: <SPEC-G vera_verdict>, raw }.
export async function callVera({ runId, parentRunId, content, context, region = REGION, invokeImpl } = {}) {
  const envelope = {
    runId,
    mode: 'task',
    task: 'review_content',
    actor: { userId: 'agent:nico' },
    payload: { content, ...(context ? { context } : {}) },
    trace: { chain: ['nico'], parentRunId: parentRunId || null },
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
// v is the deterministic engine result: { verdict, gates, quotes, suggested_fix,
// rule_ids, hold_for_human, checked_at }. Build the SPEC-G section 3.1.1
// vera_verdict shape the queue row stores (Nico owns the row when it hands
// content inline, so Nico writes this - Vera only self-writes on a contentId).
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
