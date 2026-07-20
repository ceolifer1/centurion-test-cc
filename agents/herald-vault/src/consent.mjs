// SPEC-C section 7 consent record. Two writes, BOTH required, BOTH before the
// secret exists: (1) the capability grant in ecosystem_user_grants (handled by
// db.zeroGrant / the dashboard sign-off flow), and (2) an append-only
// herald_consent_ledger row. This module owns the ledger-row shape + its state
// machine so "prove this person consented to this automation on this date with
// this scope" is a single row lookup.
export const CONSENT_STATES = ['PENDING_CONSENT', 'ACTIVE', 'ABANDONED', 'REVOKED', 'EXPIRED'];

// SPEC-C 7 capability strings, per platform + action tier. The scope granted at
// capture is the exact list stored on the ledger row.
export const CAPABILITY_STRINGS = {
  linkedin_personal: ['herald.linkedin.session', 'herald.linkedin.post.auto', 'herald.linkedin.engage.auto'],
  linkedin_company: ['herald.linkedin.session', 'herald.companypage.manage'],
  x: ['herald.x.session', 'herald.x.post.auto'],
};

const TRANSITIONS = {
  PENDING_CONSENT: { capture_success: 'ACTIVE', consent_timeout: 'ABANDONED' },
  ACTIVE: { revoke: 'REVOKED', expire: 'EXPIRED', reconsent: 'ACTIVE' },
  ABANDONED: { reconsent: 'PENDING_CONSENT' },
  EXPIRED: { reconsent: 'PENDING_CONSENT' },
  REVOKED: {},
};

export function nextConsentState(state, event) {
  const to = TRANSITIONS[state]?.[event];
  if (!to) throw new Error(`illegal consent transition: ${state} --${event}-->`);
  return to;
}

// Build the PENDING_CONSENT ledger row - written BEFORE any secret exists (SPEC-C
// 3.2 / 7). granted_by is the person themselves (self) or a super-admin acting
// on-behalf (recorded, per the mandate pattern).
export function pendingConsentRow({ person, platform, grantedBy, scope, now = () => new Date().toISOString() }) {
  const caps = Array.isArray(scope) && scope.length ? scope : (CAPABILITY_STRINGS[platform] || []);
  return {
    person, platform,
    granted_at: now(),
    granted_by: grantedBy || person,
    scope: caps,
    status: 'PENDING_CONSENT',
    capture_task_arn: null,
    revoked_at: null,
    revoked_by: null,
  };
}
