// SPEC-D warm-only engagement gate. Gia engages ONLY curated target post URNs
// (it does NOT scan the feed - LinkedIn's official API has no feed-read for this,
// and cold spray is the acceptance-rate killer). A target is engageable iff it is
// warm or explicitly curated; a cold target is skipped, never engaged, never even
// reserved. Warm signals, in priority order:
//   - explicitly curated/allow-listed by the caller        -> 'curated'
//   - existing connection / follower                        -> 'connection'
//   - the target engaged with us first                      -> 'engaged_us'
//   - a named partner/funder/press/client in the CRM        -> 'crm_partner'
//   - a post squarely inside the person's topic graph       -> 'topic_graph'
import { WARM_REASONS } from './config.mjs';

export function warmthOf(target = {}, factFile = null) {
  if (target.curated === true || target.allow === true) return { warm: true, reason: 'curated' };
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
