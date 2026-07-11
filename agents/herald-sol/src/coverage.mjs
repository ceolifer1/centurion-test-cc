// KYC-coverage scorecard (SPEC-F: Sol coverage feeds the scorecard; screen 05).
// Presence per (person x tracked platform) is derived from the person's
// approved_links in the fact-file: a platform is PRESENT when there is a real
// (non-TODO) approved link whose kind maps to it, and VERIFIED when that link is
// marked verified. Pure function - the task layer persists the snapshot.
import { TRACKED_PLATFORMS, LINK_KIND_TO_PLATFORM } from './config.mjs';

const isReal = (url) => typeof url === 'string' && url.trim() && !/todo/i.test(url);
const round1 = (n) => Math.round(n * 10) / 10;

export function personPresence(factFile) {
  const present = {}; const verified = {};
  for (const p of TRACKED_PLATFORMS) { present[p] = false; verified[p] = false; }
  for (const l of (factFile?.approved_links || [])) {
    const plat = LINK_KIND_TO_PLATFORM[String(l?.kind || '').toLowerCase()];
    if (!plat || !TRACKED_PLATFORMS.includes(plat)) continue;
    if (!isReal(l?.url)) continue;
    present[plat] = true;
    if (l?.verified === true) verified[plat] = true;
  }
  return { present, verified };
}

export function scoreOne(factFile) {
  const { present, verified } = personPresence(factFile);
  const total = TRACKED_PLATFORMS.length;
  const presentCount = TRACKED_PLATFORMS.filter((p) => present[p]).length;
  const verifiedCount = TRACKED_PLATFORMS.filter((p) => verified[p]).length;
  const gaps = TRACKED_PLATFORMS.filter((p) => !present[p]);
  return {
    person: factFile?.person_id,
    name: factFile?.name || factFile?.person_id,
    role_title: factFile?.role_title || null,
    sign_off_state: factFile?.sign_off?.state || 'unknown',
    signed_off: !!factFile?.sign_off?.signed_off,
    present, verified, gaps,
    present_count: presentCount, verified_count: verifiedCount, total,
    score: round1((presentCount / total) * 100),
    verified_score: round1((verifiedCount / total) * 100),
  };
}

// Full scorecard over a roster of fact-files (each { person_id, data }).
export function computeScorecard(factFiles) {
  const persons = factFiles.map((f) => scoreOne(f.data || f));
  const total = persons.length * TRACKED_PLATFORMS.length;
  const present = persons.reduce((a, p) => a + p.present_count, 0);
  const verified = persons.reduce((a, p) => a + p.verified_count, 0);
  const roster = {
    person_count: persons.length,
    tracked_platforms: TRACKED_PLATFORMS,
    present, verified, total,
    score: total ? round1((present / total) * 100) : 0,
    verified_score: total ? round1((verified / total) * 100) : 0,
    avg_person_score: persons.length ? round1(persons.reduce((a, p) => a + p.score, 0) / persons.length) : 0,
  };
  return { persons, roster };
}
