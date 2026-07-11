// SERP audit + Knowledge-Panel claim generation. The actual SERP fetch sits
// BEHIND an interface (deps.fetchSerp) so P1 has NO hard dependency on a paid
// SERP API: the task accepts injected results, or a flagged live fetch, or
// returns a well-formed "not configured" stub. Knowledge-Panel is claim-and-
// checklist only (produce the payload; a human submits) - Sol never submits.
import { ORG } from './config.mjs';

const domainOf = (url) => {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, ''); }
  catch { return String(url || '').toLowerCase(); }
};

// results: [{ title, url, rank, type? , owned? }]. ownedDomains: string[].
export function scoreSerp({ query, results, ownedDomains = [] }) {
  const owned = new Set(ownedDomains.map((d) => domainOf(d)));
  const top10 = [...results].sort((a, b) => (a.rank || 99) - (b.rank || 99)).slice(0, 10)
    .map((r) => ({ ...r, domain: domainOf(r.url), is_owned: r.owned === true || owned.has(domainOf(r.url)) }));
  const ownedInTop10 = top10.filter((r) => r.is_owned);
  const kp = results.find((r) => r.type === 'knowledge_panel' || r.knowledge_panel === true) || null;
  return {
    query,
    checked: top10.length,
    owned_in_top10: ownedInTop10.length,
    owned_positions: ownedInTop10.map((r) => r.rank).filter((x) => x != null).sort((a, b) => a - b),
    owned_share: top10.length ? Math.round((ownedInTop10.length / top10.length) * 100) : 0,
    knowledge_panel_present: !!kp,
    top10,
  };
}

export function serpAudit({ query, results, ownedDomains, fetchSerp } = {}) {
  if (Array.isArray(results)) return { status: 'ok', source: 'injected', ...scoreSerp({ query, results, ownedDomains }) };
  if (typeof fetchSerp === 'function') {
    return Promise.resolve(fetchSerp(query)).then((r) => ({ status: 'ok', source: 'live', ...scoreSerp({ query, results: r || [], ownedDomains }) }));
  }
  // No source configured - a legitimate P1 state, not an error. The dashboard
  // shows "SERP source not configured" until a fetcher is wired.
  return { status: 'stub', source: 'none', query, checked: 0, owned_in_top10: 0, knowledge_panel_present: false,
    note: 'No SERP source configured (P1). Inject results or wire deps.fetchSerp (flagged live fetch) to populate.' };
}

// Knowledge-Panel claim payload + verification checklist. `entity` is either the
// org anchor or a person fact-file. No automated submit (P1).
export function knowledgePanelClaim({ kind = 'org', factFile = null }) {
  if (kind === 'org') {
    return {
      kind: 'Organization', name: ORG.name, url: ORG.url,
      founding_date: ORG.foundingDate, address: `${ORG.addressLocality}, ${ORG.addressRegion}`,
      sameAs: ORG.sameAs,
      checklist: [
        'Confirm the Google Business Profile for Centurion Financial is verified (address + phone).',
        'Ensure the entity home (centurionfinancial.com) exposes Organization JSON-LD (from entity_graph).',
        'Publish/refresh the Crunchbase organization profile and link it in sameAs.',
        'Seed/curate the Wikidata item (referenced facts only) so Google has a structured source.',
        'From a signed-in Google account with edit rights, use "Suggest an edit" / claim the panel; verify ownership.',
      ],
      submit: false,
      note: 'Generate-not-submit (P1): produce this payload for a human to claim/verify the panel.',
    };
  }
  const sameAs = (factFile?.approved_links || []).filter((l) => l?.url && !/todo/i.test(l.url)).map((l) => l.url);
  return {
    kind: 'Person', name: factFile?.name || factFile?.person_id,
    jobTitle: factFile?.role_title || null, worksFor: ORG.name, sameAs,
    checklist: [
      'Confirm at least two independent, verifiable sources describe the person (entity home + LinkedIn/Crunchbase).',
      'Ensure the entity home page carries Person JSON-LD (from entity_graph) with sameAs.',
      'Confirm the fact-file is signed off before requesting a panel (unsigned persons stay draft-only).',
      'From a Google account with edit rights, claim/suggest the panel and complete identity verification.',
    ],
    submit: false,
    note: 'Generate-not-submit (P1): produce this payload for a human to claim/verify the panel.',
  };
}
