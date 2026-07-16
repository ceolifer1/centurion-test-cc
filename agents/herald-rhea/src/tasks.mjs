// Rhea's two capabilities: weekly_report + monthly_report (SPEC-G section 5).
// Read the window (queue slice, event stream, coverage snapshot) + the SPEC-F
// Option A pipeline value from leadcrm-prod, assemble the metrics, render the
// branded HTML, store it on herald_reports (idempotent), and email ceo@ via
// herald-notify. Composition and delivery are separated: a notify failure leaves
// the stored report intact with sent_at null (the Reports screen shows "resend").
import { REPORT_RECIPIENTS } from './config.mjs';
import { aggregate } from './aggregate.mjs';
import { renderReport } from './render.mjs';
import { readPipelineValue as leadcrmRead } from './leadcrm.mjs';
import { sendNotify as defaultSend } from './notify.mjs';

const DAY_MS = 86400000;
const dstr = (d) => new Date(d).toISOString().slice(0, 10);

function windowFor(type, payload, now) {
  if (payload.period?.start && payload.period?.end) {
    return { startIso: new Date(payload.period.start).toISOString(), endIso: new Date(payload.period.end).toISOString() };
  }
  const end = new Date(now);
  const span = (type === 'monthly' ? 30 : 7) * DAY_MS;
  return { startIso: new Date(end.getTime() - span).toISOString(), endIso: end.toISOString() };
}

async function buildReport({ type, payload, runId, db, now, deps = {} }) {
  const { startIso, endIso } = windowFor(type, payload, now);
  const periodStart = dstr(startIso);
  const periodEnd = dstr(endIso);

  // Window reads (each best-effort so one empty source never sinks the report).
  const queueRows = await db.queueInWindow(startIso, endIso).catch(() => []);
  const events = await db.eventsInWindow(startIso, endIso).catch(() => []);
  const coverage = await db.coverageOnOrBefore(periodEnd).catch(() => ({ date: null, rows: [] }));
  const priorReport = await db.priorReport(type, startIso).catch(() => null);
  const needsYou = await db.needsYouOpen().catch(() => []);

  // SPEC-F Option A pipeline value from leadcrm-prod (the same read path
  // cf-mandate-ops/deal-brain use). Injectable; unavailability degrades the
  // headline, it does not fail the report.
  const readPipeline = deps.readPipelineValue || (() => leadcrmRead({ fetchImpl: deps.fetch }));
  let pipeline = null; let pipelineError = null;
  try { pipeline = await readPipeline(); } catch (e) { pipelineError = e.message; }

  const metrics = aggregate({
    type, periodStart, periodEnd, queueRows, events, coverage, priorReport, pipeline,
    followSuggestions: payload.followSuggestions,
  });
  metrics.needs_you = { open: needsYou.length, items: needsYou.slice(0, 10) };
  if (pipelineError) metrics.pipeline_error = pipelineError;

  const { subject, html } = renderReport(metrics);

  // Store first (the durable artifact the Reports screen renders), then send.
  const row = await db.upsertReport({
    type, period_start: periodStart, period_end: periodEnd, subject, body_html: html, metrics, sent_to: [], sent_at: null,
  });
  const reportId = row?.id || null;
  await db.insertEvent({ agent: 'rhea', subject_id: reportId, event_type: 'report.composed',
    payload: { runId, type, period_start: periodStart, period_end: periodEnd, posted: metrics.posted.count, pipeline: metrics.pipeline?.display || null } }).catch(() => {});

  // Send via herald-notify (SPEC-G section 6).
  const send = deps.sendNotify || ((args) => defaultSend(args, deps.fetch));
  let sent = false; let sendError = null;
  try {
    await send({ kind: 'report', to: REPORT_RECIPIENTS, subject, html });
    sent = true;
  } catch (e) { sendError = e.message; }

  if (sent) {
    if (reportId) await db.markReportSent(reportId, REPORT_RECIPIENTS, now).catch(() => {});
    await db.insertEvent({ agent: 'rhea', subject_id: reportId, event_type: 'report.sent',
      payload: { runId, to: REPORT_RECIPIENTS } }).catch(() => {});
    await db.insertEvent({ agent: 'rhea', subject_id: reportId, event_type: 'notify.sent',
      payload: { runId, kind: 'report' } }).catch(() => {});
  } else {
    await db.insertEvent({ agent: 'rhea', subject_id: reportId, event_type: 'report.send_failed',
      payload: { runId, error: sendError } }).catch(() => {});
  }

  return {
    status: 'ok', subjectId: reportId, eventType: sent ? 'report.sent' : 'report.send_failed',
    reply: `${type[0].toUpperCase()}${type.slice(1)} report ${periodStart}..${periodEnd} composed (pipeline ${metrics.pipeline?.display || 'n/a'}); ${sent ? `emailed ${REPORT_RECIPIENTS.join(', ')}` : `NOT sent (${sendError})`}. ${metrics.follows.line}.`,
    artifacts: [{ type: 'presence_report', ref: reportId ? `herald_reports:${reportId}` : 'unsaved', data: { subject, metrics } }],
    payloadOut: { type, period_start: periodStart, period_end: periodEnd, sent, pipeline: metrics.pipeline?.display || null, follows_queued: metrics.follows.queued },
  };
}

export const weeklyReport = (ctx) => buildReport({ type: 'weekly', ...ctx });
export const monthlyReport = (ctx) => buildReport({ type: 'monthly', ...ctx });
