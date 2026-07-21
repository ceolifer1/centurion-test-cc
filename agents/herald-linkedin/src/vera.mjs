// Peer edge linkedin -> Vera review_content (SPEC-H section 4). The publisher
// RE-VERIFIES Vera on the EXACT final text immediately before posting - a
// vera_pass on the queue row is necessary but not sufficient; the text that goes
// to LinkedIn is re-cleared so an edited/tampered body can never post. Vera's
// handler accepts a direct (non-HTTP) event and proves the caller by IAM +
// ALLOWED_CALLERS (chain last element = 'linkedin'). @aws-sdk/client-lambda ships
// in nodejs20.x, imported lazily so tests never touch AWS (mock via deps.reviewImpl).
import { REGION, VERA_FUNCTION } from './config.mjs';

// Returns { verdict: 'pass'|'bounce', vera, raw }.
export async function reviewContent({ runId, parentRunId, content, context, region = REGION, invokeImpl } = {}) {
  const envelope = {
    runId,
    mode: 'task',
    task: 'review_content',
    actor: { userId: 'agent:linkedin' },
    payload: { content, ...(context ? { context } : {}) },
    trace: { chain: ['linkedin'], parentRunId: parentRunId || null },
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

function normalize(raw) {
  const status = raw?.status || 'error';
  if (status === 'killed' || status === 'refused' || status === 'error') {
    return { verdict: 'bounce', blocked: true, status, vera: shapeVerdict(null, 'bounce', raw), raw };
  }
  const v = (raw?.artifacts || []).find((a) => a?.type === 'vera_verdict')?.data || null;
  const verdict = raw?.verdict || v?.verdict || 'bounce';
  return { verdict, status, vera: shapeVerdict(v, verdict, raw), raw };
}

function shapeVerdict(v, verdict, raw) {
  return {
    verdict,
    at: v?.checked_at || new Date().toISOString(),
    gates: v?.gates || [],
    bounce_reasons: v ? (v.quotes || []).map((q) => `${q.rule_id}: "${q.quote}"`)
      : [`vera ${raw?.status || 'error'}: ${raw?.reply || raw?.error || 'refused'}`],
    rule_ids: v?.rule_ids || [],
    hold_for_human: !!v?.hold_for_human,
  };
}
