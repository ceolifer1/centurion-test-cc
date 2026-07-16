// Entity-graph generation (DATA only - no publishing). Emits schema.org
// Person/Organization JSON-LD with sameAs links and a set of Wikidata seed
// statements (referenced facts only). Everything is derived from the approved
// fact-file; TODO/unverified placeholder links are never emitted, and no claim
// the fact-file forbids is ever produced. Output is a payload for a human to
// place on the entity home / submit to Wikidata - Sol never submits.
import { ORG } from './config.mjs';

const isReal = (url) => typeof url === 'string' && url.trim() && !/todo/i.test(url);
const httpsify = (url) => (/^https?:\/\//i.test(url) ? url : `https://${url.replace(/^\/+/, '')}`);
const clean = (s) => (typeof s === 'string' && s.trim() && !/^todo/i.test(s.trim()) ? s.trim() : null);

// sameAs = verified, real approved links (the identity anchors search engines use).
export function sameAsFor(factFile) {
  return (factFile?.approved_links || [])
    .filter((l) => isReal(l?.url) && l?.verified !== false)
    .map((l) => httpsify(l.url));
}

export function organizationJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: ORG.name,
    legalName: ORG.legalName,
    url: ORG.url,
    foundingDate: ORG.foundingDate,
    address: { '@type': 'PostalAddress', addressLocality: ORG.addressLocality, addressRegion: ORG.addressRegion, addressCountry: ORG.addressCountry },
    sameAs: ORG.sameAs,
  };
}

export function personJsonLd(factFile) {
  const jobTitle = clean(factFile?.role_title);
  const schools = (factFile?.education || []).map((e) => clean(e?.school)).filter(Boolean);
  const person = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: factFile?.name || factFile?.person_id,
    worksFor: { '@type': 'Organization', name: ORG.name, url: ORG.url },
    sameAs: sameAsFor(factFile),
  };
  if (jobTitle) person.jobTitle = jobTitle;
  if (clean(factFile?.approved_bio)) person.description = factFile.approved_bio.trim();
  if (clean(factFile?.location)) person.homeLocation = { '@type': 'Place', name: factFile.location.trim() };
  if (schools.length) person.alumniOf = schools.map((name) => ({ '@type': 'EducationalOrganization', name }));
  return person;
}

// Wikidata seed statements - conservative, referenced-facts-only (SPEC-D 6.1:
// promotional/unreferenced edits are Vera-blocked). Reference = the person's
// entity home when present, else the org site. These are SUGGESTIONS for a human
// editor, not automated edits.
export function wikidataSeeds(factFile) {
  const ref = sameAsFor(factFile).find((u) => /centurionfinancial\.com/i.test(u)) || ORG.url;
  const stmts = [
    { property: 'P31', propertyLabel: 'instance of', value: 'Q5', valueLabel: 'human', reference: ref },
    { property: 'P108', propertyLabel: 'employer', value: ORG.name, valueLabel: ORG.name, reference: ref },
  ];
  const title = clean(factFile?.role_title);
  if (title) stmts.push({ property: 'P39', propertyLabel: 'position held', value: title, valueLabel: title, reference: ref });
  for (const u of sameAsFor(factFile)) {
    if (/linkedin\.com/i.test(u)) stmts.push({ property: 'P6634', propertyLabel: 'LinkedIn personal profile ID', value: u, valueLabel: u, reference: ref });
    if (/crunchbase\.com/i.test(u)) stmts.push({ property: 'P2087', propertyLabel: 'Crunchbase person ID', value: u, valueLabel: u, reference: ref });
  }
  return stmts;
}

export function buildEntityGraph(factFile) {
  const person = personJsonLd(factFile);
  return {
    person_id: factFile?.person_id,
    person_jsonld: person,
    organization_jsonld: organizationJsonLd(),
    wikidata_seeds: wikidataSeeds(factFile),
    sameAs: person.sameAs,
    notes: 'Generate-not-submit (P1): place person_jsonld on the entity home <script type="application/ld+json">; wikidata_seeds are human-reviewed edit suggestions.',
  };
}
