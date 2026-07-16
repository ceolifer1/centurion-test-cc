// Branded HTML email (SPEC-G section 5.1/6): Centurion gold-on-vault tombstone
// styling, table-based layout, inline CSS with baked hex (the Vault CSS vars do
// not survive email clients). One CTA -> the Reports screen. The SAME html is
// stored on herald_reports.body_html so the email and the dashboard can never
// disagree. Escapes all interpolated text (report content is data, not markup).
const GOLD = '#C9A227', VAULT = '#0F1729', PANEL = '#16213A', LINE = '#243149', TEXT = '#E5E7EB', MUTED = '#9AA5B8';
const DASH_URL = 'https://centurionfinancial.com/admin/presence/reports';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const sign = (n) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${fmt(n)}`);

function kpi(label, value, sub) {
  return `<td style="padding:14px 12px;background:${PANEL};border:1px solid ${LINE};border-radius:10px;text-align:center;">
    <div style="font-size:26px;font-weight:700;color:${GOLD};line-height:1;">${esc(value)}</div>
    <div style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:.06em;margin-top:6px;">${esc(label)}</div>
    ${sub ? `<div style="font-size:11px;color:${TEXT};margin-top:2px;">${esc(sub)}</div>` : ''}
  </td>`;
}

function section(title, inner) {
  return `<tr><td style="padding:20px 24px 6px;">
    <div style="font-size:13px;font-weight:700;color:${GOLD};text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid ${LINE};padding-bottom:6px;">${esc(title)}</div>
    <div style="margin-top:10px;color:${TEXT};font-size:14px;line-height:1.5;">${inner}</div>
  </td></tr>`;
}

export function renderReport(m) {
  const title = m.type === 'monthly' ? 'HERALD Monthly Presence Report' : 'HERALD Weekly Presence Report';
  const subject = `${title} — ${m.period_start} to ${m.period_end}`;

  const postedList = (m.posted.items || []).length
    ? `<ul style="margin:0;padding-left:18px;">${m.posted.items.map((p) => `<li>${esc(p.person)} · ${esc(p.platform)}${p.title ? ` — ${esc(p.title)}` : ''}</li>`).join('')}</ul>`
    : `<span style="color:${MUTED};">No posts published this period.</span>`;

  const coverageBlock = m.coverage.roster_score == null
    ? `<span style="color:${MUTED};">Coverage tracking starts next week.</span>`
    : `Roster KYC-coverage: <b style="color:${GOLD};">${m.coverage.roster_score}%</b>` +
      (m.coverage.delta != null ? ` <span style="color:${MUTED};">(${sign(m.coverage.delta)} pts vs last report)</span>` : '') +
      (m.coverage.people?.length ? `<div style="margin-top:8px;font-size:13px;color:${MUTED};">${m.coverage.people.map((p) => `${esc(p.person)}: ${p.score}%`).join(' · ')}</div>` : '');

  const capsBlock = `${m.caps.warnings} cap warning(s), ${m.caps.stops} hard stop(s) this period.`;
  const bounceBlock = `${m.bounces.count} bounced, ${m.bounces.skipped} skipped.`;

  const pipelineHeadline = m.pipeline
    ? `<div style="text-align:center;padding:16px;background:${PANEL};border:1px solid ${LINE};border-radius:10px;">
        <div style="font-size:30px;font-weight:800;color:${GOLD};">${esc(m.pipeline.display)}</div>
        <div style="font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.06em;margin-top:4px;">Current active pipeline · ${fmt(m.pipeline.deal_count)} open deals</div>
        <div style="font-size:11px;color:${MUTED};margin-top:4px;">Capital sought (Option A). Never AUM or raised.</div>
      </div>`
    : `<span style="color:${MUTED};">Pipeline value unavailable this period.</span>`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:${VAULT};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${VAULT};padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:640px;background:${VAULT};border:1px solid ${LINE};border-radius:14px;font-family:Georgia,'Times New Roman',serif;">
        <tr><td style="padding:22px 24px;border-bottom:1px solid ${LINE};">
          <div style="font-size:12px;letter-spacing:.18em;color:${GOLD};text-transform:uppercase;">Centurion Financial · HERALD</div>
          <div style="font-size:22px;color:${TEXT};font-weight:700;margin-top:4px;">${esc(title)}</div>
          <div style="font-size:13px;color:${MUTED};margin-top:2px;">${esc(m.period_start)} — ${esc(m.period_end)}</div>
        </td></tr>
        <tr><td style="padding:18px 24px 4px;">${pipelineHeadline}</td></tr>
        <tr><td style="padding:14px 24px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="8"><tr>
            ${kpi('Posted', fmt(m.posted.count))}
            ${kpi('Reach 7d', fmt(m.engagement.reach), m.delta.reach != null ? `${sign(m.delta.reach)} vs prior` : '')}
            ${kpi('Engagement', fmt(m.engagement.total), m.delta.engagement != null ? `${sign(m.delta.engagement)} vs prior` : '')}
            ${kpi('Net-new followers', sign(m.followers.net_new))}
          </tr></table>
        </td></tr>
        ${section('What posted', postedList)}
        ${section('Follows', `<b style="color:${GOLD};">${esc(m.follows.line)}</b>`)}
        ${section('Coverage', coverageBlock)}
        ${section('Platform-safety caps', capsBlock)}
        ${section('Bounces &amp; held items', bounceBlock)}
        <tr><td style="padding:22px 24px 26px;text-align:center;">
          <a href="${DASH_URL}" style="display:inline-block;background:${GOLD};color:${VAULT};text-decoration:none;font-weight:700;font-family:Arial,sans-serif;font-size:14px;padding:12px 26px;border-radius:8px;">Open the Reports screen</a>
        </td></tr>
        <tr><td style="padding:14px 24px;border-top:1px solid ${LINE};color:${MUTED};font-size:11px;font-family:Arial,sans-serif;">
          Centurion Financial · 2800 Post Oak Blvd STE 5900, Houston, TX 77056 · Generated by HERALD (Rhea). Figures are current active pipeline, not AUM or capital raised.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;

  return { subject, html };
}
