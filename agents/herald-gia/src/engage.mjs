// SPEC-D warm-only engagement + reserve-then-act. Gia is the PROPOSER: it decides
// WHICH warm target to engage and reserves the platform-safety cap BEFORE the
// action is cleared for execution. It never runs a browser and never touches a
// session - a cleared engagement is picked up by the browser executor (Piper
// family) downstream. Two hard rules live here:
//   1. WARM-ONLY (SPEC-D 1): a cold target is skipped, never engaged, never even
//      reserved. Warmth must be one of WARM_REASONS - no cold spray, ever.
//   2. RESERVE-THEN-ACT with HARD-STOP (SPEC-D 7): a would-exceed on ANY window
//      stops the WHOLE run for that (person, platform) - no throttle, no carry.
import { WARM_REASONS } from './config.mjs';

// Decide whether a target is warm and why (SPEC-D warm-only engagement). Returns
// { warm:true, reason } for the FIRST matching warm signal, else { warm:false }.
// Warm signals, in priority order:
//   - existing connection / follower               -> 'connection'
//   - the target engaged with us first             -> 'engaged_us'
//   - a named partner/funder/press in the CRM      -> 'crm_partner'
//   - a post squarely inside the person's topics   -> 'topic_graph'
export function warmthOf(target = {}, factFile = null) {
  const rel = String(target.relationship || '').toLowerCase();
  if (rel === 'connection' || rel === 'follower' || rel === 'first_degree' || target.is_connection === true) {
    return { warm: true, reason: 'connection' };
  }
  if (target.engaged_us === true) return { warm: true, reason: 'engaged_us' };
  const crm = String(target.crm_tag || '').toLowerCase();
  if (['partner', 'funder', 'press', 'client'].includes(crm) || target.in_crm === true) {
    return { warm: true, reason: 'crm_partner' };
  }
  const topics = (factFile?.topic_graph || factFile?.topics || []).map((t) => String(t).toLowerCase());
  const tTopics = (target.topics || []).map((t) => String(t).toLowerCase());
  if (topics.length && tTopics.some((t) => topics.includes(t))) return { warm: true, reason: 'topic_graph' };
  return { warm: false, reason: null };
}

export function isWarmReason(reason) { return WARM_REASONS.includes(reason); }
