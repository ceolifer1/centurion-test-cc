// Pure metrics assembly for the Rhea report (SPEC-G section 5.1). Takes the raw
// window reads and produces the structured `metrics` object stored on
// herald_reports (drives the Reports screen, mockup 06) - no I/O, so it is
// trivially testable. The five sections: what posted, engagement, coverage delta,
// caps utilization, bounces + held items; plus the SPEC-F pipeline headline and
// the mandatory "follows queued for your tap" line.
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

const ENGAGEMENT_KEYS = ['impressions', 'reach', 'reactions', 'likes', 'comments', 'replies', 'shares', 'reposts'];

export function aggregate({
  type = 'weekly', periodStart, periodEnd,
  queueRows = [], events = [], coverage = { date: null, rows: [] },
  priorReport = null, pipeline = null, followSuggestions = null,
}) {
  const byStatus = (st) => queueRows.filter((r) => r.status === st);
  const posted = byStatus('posted').map((r) => ({ person: r.person, platform: r.platform, title: r.title, kind: r.kind, external_ref: r.external_ref }));
  const bouncedCount = byStatus('bounced').length;
  const skippedCount = byStatus('skipped').length;

  // Engagement + follower deltas from the event stream.
  const engagement = {}; ENGAGEMENT_KEYS.forEach((k) => { engagement[k] = 0; });
  let netNewFollowers = 0;
  const perPlatform = {};
  let capsWarnings = 0; let capsStops = 0;
  let followsFromEvents = 0;

  for (const e of events) {
    const t = e.event_type || '';
    const p = e.payload || {};
    if (t === 'content.posted' || t === 'content.metrics' || t.endsWith('.metrics')) {
      for (const k of ENGAGEMENT_KEYS) if (p[k] != null) engagement[k] += num(p[k]);
      const plat = p.platform || e.payload?.platform;
      if (plat) { perPlatform[plat] = perPlatform[plat] || { posts: 0, reactions: 0, impressions: 0 };
        if (t === 'content.posted') perPlatform[plat].posts += 1;
        perPlatform[plat].reactions += num(p.reactions || p.likes);
        perPlatform[plat].impressions += num(p.impressions || p.reach); }
    }
    if (t === 'followers.delta' || t === 'followers.snapshot') netNewFollowers += num(p.delta ?? p.net_new ?? 0);
    if (t === 'caps.warning') capsWarnings += 1;
    if (t === 'caps.stop') capsStops += 1;
    if (t === 'follow.suggested' || t === 'x.follow_suggested' || t === 'follow.queued') followsFromEvents += 1;
  }

  const reach = engagement.impressions || engagement.reach || 0;
  const engagementTotal = engagement.reactions + engagement.likes + engagement.comments + engagement.replies + engagement.shares + engagement.reposts;

  // Coverage: the roster rollup + a delta vs the prior report's stored score.
  const rosterRow = (coverage.rows || []).find((r) => r.person === '_roster') || null;
  const coverageScore = rosterRow ? num(rosterRow.score) : null;
  const priorCoverage = priorReport?.metrics?.coverage?.roster_score ?? null;
  const coverageDelta = (coverageScore != null && priorCoverage != null) ? Math.round((coverageScore - priorCoverage) * 10) / 10 : null;
  const personCoverage = (coverage.rows || []).filter((r) => r.person !== '_roster')
    .map((r) => ({ person: r.person, score: num(r.score), gaps: r.gaps || [] }));

  // Deltas vs prior report (reach / engagement / followers).
  const pm = priorReport?.metrics || {};
  const delta = {
    reach: pm.engagement?.reach != null ? reach - num(pm.engagement.reach) : null,
    engagement: pm.engagement?.total != null ? engagementTotal - num(pm.engagement.total) : null,
    followers: pm.followers?.net_new != null ? netNewFollowers - num(pm.followers.net_new) : null,
  };

  // The mandatory follows line (SPEC-D: X automated follows DISABLED at P0).
  const followsQueued = followSuggestions != null ? num(followSuggestions) : followsFromEvents;

  return {
    type, period_start: periodStart, period_end: periodEnd,
    posted: { count: posted.length, items: posted, by_platform: perPlatform },
    engagement: { ...engagement, reach, total: engagementTotal },
    followers: { net_new: netNewFollowers },
    delta,
    coverage: { snapshot_date: coverage.date, roster_score: coverageScore, delta: coverageDelta, people: personCoverage },
    caps: { warnings: capsWarnings, stops: capsStops },
    bounces: { count: bouncedCount, skipped: skippedCount },
    follows: { queued: followsQueued, automated_disabled: true,
      line: `X follows: ${followsQueued} queued for your tap — automated follows disabled` },
    pipeline: pipeline ? { display: pipeline.display, value: pipeline.value, deal_count: pipeline.deal_count, framing: pipeline.framing, basis: pipeline.basis } : null,
  };
}
