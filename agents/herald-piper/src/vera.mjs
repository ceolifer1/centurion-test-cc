// Completion callback edge Piper -> Vera confirm_posted (SPEC-H section 4 step 9,
// chain ['nico','vera','piper'] or ['piper'] for a standalone run). Piper is
// Fargate, so it invokes Vera's Lambda directly (lambda:InvokeFunction, granted
// by invoke_peers = ["vera"]). Vera proves the caller by IAM + ALLOWED_CALLERS
// (last chain element 'piper'). @aws-sdk/client-lambda is a real dep here (the
// Playwright base image lacks the runtime aws-sdk); imported lazily for tests.
import { REGION, VERA_FUNCTION } from './config.mjs';

export async function confirmPosted({ runId, parentRunId, chain = ['piper'], contentId, postUrl, region = REGION, invokeImpl } = {}) {
  const envelope = {
    runId, mode: 'watch', task: 'confirm_posted', actor: { userId: 'agent:piper' },
    payload: { contentId, postUrl }, trace: { chain, parentRunId: parentRunId || null },
  };
  const invoke = invokeImpl || (await defaultInvoke(region));
  try { return await invoke(envelope); } catch (e) { return { status: 'error', error: e.message }; }
}

async function defaultInvoke(region) {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const client = new LambdaClient({ region });
  return async (envelope) => {
    const res = await client.send(new InvokeCommand({
      FunctionName: VERA_FUNCTION, InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify(envelope)),
    }));
    const txt = Buffer.from(res.Payload || []).toString('utf8') || '{}';
    if (res.FunctionError) throw new Error(`vera invoke error: ${txt.slice(0, 200)}`);
    return JSON.parse(txt);
  };
}
