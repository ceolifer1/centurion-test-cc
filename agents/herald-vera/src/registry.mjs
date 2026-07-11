// SPEC-E section 1.3 - the global fact registry (whitelist), seeded from the
// locked KYC fact base. Claim rules (VERA-C01/C02) resolve against fact text
// plus the subject fact-file's approved_claims[]. Versioned: verdicts record
// ruleset_version so historical verdicts stay reproducible.
export const FACT_REGISTRY = {
  version: 1,
  facts: [
    { fact_id: 'F-001', text: 'Centurion Financial founded 2021' },
    { fact_id: 'F-002', text: "Metric framing: principals' lifetime transactions advised/closed" },
    { fact_id: 'F-003', text: 'Deal-flow headline = current active pipeline value only', evidence: 'leadcrm:pipeline_active_value (live query)', never: 'lifetime aggregate' },
    { fact_id: 'F-004', text: "Use 'term sheets', never 'closed capital'" },
    { fact_id: 'F-005', text: 'Powered Labs one-liner only: 2010-2018, exited' },
    { fact_id: 'F-006', text: "Tricia Littell = COO. 'Head Underwriter' is a proposed restructure function only." },
    { fact_id: 'F-007', text: "'Sum Capital' must not be named until the Singapore JV signs.", sunset: 'on JV signature - Ashton updates registry' },
    { fact_id: 'F-008', text: 'Ashton verified companies (closed list): Microsoft, Credit Suisse, CH2M Hill (now Jacobs Engineering), Chase.' },
    { fact_id: 'F-009', text: 'Client names published only when per-deal client_name_consent = TRUE; else anonymized + size-banded.' },
    { fact_id: 'F-010', text: 'Publication dates always real; never backdated.' },
    { fact_id: 'F-011', text: 'Three sites: centurionfinancial.com, Centurion International, Centurion Japan.' },
  ],
};

// VERA-N02 size bands (SPEC-E, proposal pending Ashton confirmation).
export const SIZE_BANDS = ['$1-5M', '$5-15M', '$15-50M', '$50M+'];
