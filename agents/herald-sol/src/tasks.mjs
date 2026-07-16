// Sol's four capabilities, all DETERMINISTIC + generate-not-submit:
//   entity_graph   -> schema.org JSON-LD + sameAs + Wikidata seeds (data only)
//   coverage_audit -> KYC-coverage scorecard snapshot (herald_coverage; screen 05)
//   serp_audit     -> SERP scorecard behind an injectable interface (no paid dep)
//   knowledge_panel-> Google Knowledge-Panel claim payload + checklist (no submit)
import { ROSTER, TRACKED_PLATFORMS } from './config.mjs';
import { buildEntityGraph, organizationJsonLd } from './jsonld.mjs';
import { computeScorecard } from './coverage.mjs';
import { serpAudit as runSerp, knowledgePanelClaim } from './serp.mjs';

const dateOf = (now) => now.slice(0, 10);

async function resolveFactFiles({ payload, db }) {
  if (Array.isArray(payload.factFiles)) return payload.factFiles; // test / caller injection
  if (Array.isArray(payload.personIds) && payload.personIds.length) {
    const out = [];
    for (const pid of payload.personIds) { const f = await db.getFactFile(pid); if (f) out.push(f); }
    return out;
  }
  if (payload.person) { const f = await db.getFactFile(payload.person); return f ? [f] : []; }
  return db.listFactFiles();
}

export async function entityGraphTask({ payload, runId, db }) {
  const files = await resolveFactFiles({ payload, db });
  if (!files.length) return { status: 'error', error: 'no fact-files resolved (pass payload.person / personIds, or seed herald_fact_files)' };
  const graphs = files.map((f) => buildEntityGraph(f.data || f));
  for (const g of graphs) {
    await db.insertEvent({ agent: 'sol', person: g.person_id, subject_id: null, event_type: 'entity.graph_built',
      payload: { runId, sameas_count: g.sameAs.length, wikidata_seed_count: g.wikidata_seeds.length } }).catch(() => {});
  }
  return {
    status: 'ok', person: files.length === 1 ? graphs[0].person_id : null, eventType: 'entity.graph_built',
    reply: `Built entity graph JSON-LD for ${graphs.length} person(s) + the organization anchor (generate-not-submit).`,
    artifacts: [{ type: 'entity_graph', ref: 'entity_graph', data: { organization: organizationJsonLd(), people: graphs } }],
    payloadOut: { people: graphs.length },
  };
}

export async function coverageAuditTask({ payload, runId, db, now }) {
  const files = Array.isArray(payload.factFiles) ? payload.factFiles
    : (Array.isArray(payload.roster) && payload.roster.length
      ? (await Promise.all(payload.roster.map((p) => db.getFactFile(p)))).filter(Boolean)
      : await db.listFactFiles());
  if (!files.length) return { status: 'error', error: 'no fact-files to audit' };
  const snapshotDate = payload.snapshotDate || dateOf(now);
  const { persons, roster } = computeScorecard(files);

  // Persist per-person snapshots + a roster rollup row (idempotent per date).
  for (const p of persons) {
    await db.upsertCoverage({
      snapshot_date: snapshotDate, person: p.person, score: p.score,
      present: p.present_count, total: p.total,
      platforms: p.present, gaps: p.gaps, created_by: 'sol',
    }).catch(() => {});
  }
  await db.upsertCoverage({
    snapshot_date: snapshotDate, person: '_roster', score: roster.score,
    present: roster.present, total: roster.total,
    platforms: { avg_person_score: roster.avg_person_score, verified_score: roster.verified_score },
    gaps: [], created_by: 'sol',
  }).catch(() => {});

  let priorDate = null;
  try { priorDate = await db.priorCoverageDate(snapshotDate); } catch { priorDate = null; }

  await db.insertEvent({ agent: 'sol', person: null, subject_id: null, event_type: 'coverage.audited',
    payload: { runId, snapshot_date: snapshotDate, roster_score: roster.score, person_count: persons.length,
      tracked_platforms: TRACKED_PLATFORMS, prior_date: priorDate } }).catch(() => {});

  return {
    status: 'ok', eventType: 'coverage.audited',
    reply: `Coverage scorecard ${snapshotDate}: roster ${roster.score}% across ${persons.length} people, ${TRACKED_PLATFORMS.length} platforms.`,
    artifacts: [{ type: 'coverage_scorecard', ref: `herald_coverage:${snapshotDate}`, data: { snapshot_date: snapshotDate, prior_date: priorDate, persons, roster } }],
    payloadOut: { snapshot_date: snapshotDate, roster_score: roster.score, persons: persons.length },
  };
}

export async function serpAuditTask({ payload, runId, db, deps = {} }) {
  const query = payload.query || null;
  if (!query) return { status: 'error', error: 'payload.query is required' };
  const result = await runSerp({ query, results: payload.results, ownedDomains: payload.ownedDomains || [], fetchSerp: payload.live ? deps.fetchSerp : undefined });
  await db.insertEvent({ agent: 'sol', person: payload.person || null, subject_id: null, event_type: 'serp.audited',
    payload: { runId, query, source: result.source, owned_in_top10: result.owned_in_top10 ?? null, knowledge_panel: result.knowledge_panel_present ?? null } }).catch(() => {});
  return {
    status: 'ok', person: payload.person || null, eventType: 'serp.audited',
    reply: result.status === 'stub'
      ? `SERP audit for "${query}": no source configured (P1 stub).`
      : `SERP audit for "${query}": ${result.owned_in_top10}/${result.checked} owned in top 10, panel ${result.knowledge_panel_present ? 'present' : 'absent'}.`,
    artifacts: [{ type: 'serp_scorecard', ref: 'serp', data: result }],
    payloadOut: { source: result.source, owned_in_top10: result.owned_in_top10 ?? null },
  };
}

export async function knowledgePanelTask({ payload, runId, db }) {
  const kind = payload.kind === 'person' ? 'person' : 'org';
  let factFile = null;
  if (kind === 'person') {
    if (!payload.person) return { status: 'error', error: 'payload.person required for a person panel claim' };
    factFile = (payload.factFile) || (await db.getFactFile(payload.person))?.data || null;
    if (!factFile) return { status: 'error', error: `no fact-file for ${payload.person}` };
  }
  const claim = knowledgePanelClaim({ kind, factFile });
  await db.insertEvent({ agent: 'sol', person: kind === 'person' ? payload.person : null, subject_id: null,
    event_type: 'panel.claim_built', payload: { runId, kind, checklist_steps: claim.checklist.length } }).catch(() => {});
  return {
    status: 'ok', person: kind === 'person' ? payload.person : null, eventType: 'panel.claim_built',
    reply: `Built a ${claim.kind} Knowledge-Panel claim payload + ${claim.checklist.length}-step checklist (generate-not-submit).`,
    artifacts: [{ type: 'knowledge_panel_claim', ref: 'panel', data: claim }],
    payloadOut: { kind, submit: false },
  };
}
