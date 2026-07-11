-- HERALD Stage 1 substrate (SPEC-G section 3, SPEC-H sections 1/2/3.1/5/7, SPEC-E section 3).
-- Additive + idempotent. Applied 2026-07-11 as migration herald_substrate_v1 to
-- CF dev anvbfibhgokjtrwexaps -> test jdxuejbnecjugqlufhjp -> prod hruwrnbrlnitytneeafv.

-- 0) Grants-based capability helper. NOTE: existing public.user_has_capability is
-- role_capabilities-based (CF app roles) and NOT equivalent to the mandate-ops
-- grants pattern; this helper reads ecosystem_user_grants.capabilities and is
-- robust to the jsonb (prod) vs text[] (dev/test) column-type drift via to_jsonb().
create or replace function public.herald_has_capability(p_uid uuid, p_cap text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from public.ecosystem_user_grants g
    where g.user_id = p_uid
      and g.is_active
      and to_jsonb(g.capabilities) ? p_cap
  );
$fn$;

-- 1) Content queue (SPEC-G 3.1)
create table if not exists public.herald_content_queue (
  id             uuid primary key default gen_random_uuid(),
  person         text not null,
  platform       text not null check (platform in
                   ('linkedin_personal','linkedin_company','x','google_business',
                    'crunchbase','the_org','activity_page')),
  kind           text not null default 'post' check (kind in
                   ('post','comment','reshare','thread','tombstone','profile_update')),
  title          text,
  body           text not null,
  media          jsonb not null default '[]'::jsonb,
  status         text not null default 'draft' check (status in
                   ('draft','vera_pass','approved','scheduled','posted','bounced','skipped')),
  tier           text not null check (tier in ('crawl','run')),
  vera_verdict   jsonb,
  created_by     text not null,
  parent_id      uuid references public.herald_content_queue(id),
  scheduled_for  timestamptz,
  posted_at      timestamptz,
  external_ref   text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists herald_queue_needs_you on public.herald_content_queue (created_at desc)
  where status = 'vera_pass' and tier = 'crawl';
create index if not exists herald_queue_bounced on public.herald_content_queue (created_at desc)
  where status = 'bounced';
create index if not exists herald_queue_due on public.herald_content_queue (scheduled_for)
  where status = 'scheduled';
create index if not exists herald_queue_person on public.herald_content_queue (person, status);

-- 2) Approvals (SPEC-G 3.2)
create table if not exists public.herald_approvals (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.herald_content_queue(id),
  approver    text not null,
  decision    text not null check (decision in ('approve','reject','skip','send_now','auto_run')),
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists herald_approvals_item on public.herald_approvals (item_id, created_at desc);

-- 3) Reports (SPEC-G 3.3)
create table if not exists public.herald_reports (
  id            uuid primary key default gen_random_uuid(),
  type          text not null check (type in ('weekly','monthly')),
  period_start  date not null,
  period_end    date not null,
  subject       text not null,
  body_html     text not null,
  metrics       jsonb not null default '{}'::jsonb,
  sent_to       text[] not null default '{}',
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),
  unique (type, period_start, period_end)
);

-- 4) Events - AGT-3 audit stream (SPEC-G 3.4), append-only
create table if not exists public.herald_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  agent       text not null,
  event_type  text not null,
  subject_id  uuid,
  person      text,
  payload     jsonb not null default '{}'::jsonb
);
create index if not exists herald_events_at on public.herald_events (at desc);
create index if not exists herald_events_subject on public.herald_events (subject_id);
create index if not exists herald_events_type on public.herald_events (event_type, at desc);

create or replace function public.herald_events_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  raise exception 'herald_events is append-only (AGT-3)';
end
$fn$;
drop trigger if exists herald_events_no_mutate on public.herald_events;
create trigger herald_events_no_mutate
  before update or delete on public.herald_events
  for each row execute function public.herald_events_immutable();

-- 5) Kill switch / controls (SPEC-H 5)
create table if not exists public.herald_controls (
  scope   text primary key,
  state   text not null default 'run' check (state in ('run','pause','kill')),
  reason  text,
  set_by  text,
  set_at  timestamptz not null default now()
);
insert into public.herald_controls (scope, state, reason, set_by)
values ('global', 'run', 'initial seed', 'migration:herald_substrate_v1')
on conflict (scope) do nothing;

-- 6) Schedules registry (SPEC-H 2.1). EventBridge is the executor, this is the truth.
create table if not exists public.herald_schedules (
  id                uuid primary key default gen_random_uuid(),
  agent             text not null,
  name              text not null,
  cadence           text not null,
  timezone          text not null default 'America/Chicago',
  payload           jsonb not null default '{}'::jsonb,
  mode              text not null default 'scheduled' check (mode in ('scheduled','dry_run')),
  on_behalf_of      uuid,
  enabled           boolean not null default false,
  eb_schedule_name  text,
  last_synced_at    timestamptz,
  sync_state        text not null default 'pending',
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists herald_schedules_agent on public.herald_schedules (agent, enabled);

-- 7) Agent registry (SPEC-H 7) - LINDA's future routing table
create table if not exists public.herald_agents (
  agent       text primary key,
  service     text not null,
  variant     text not null check (variant in ('lambda','fargate')),
  endpoint    text,
  manifest    jsonb not null default '{}'::jsonb,
  cost_class  text,
  health      text not null default 'amber' check (health in ('green','amber','red')),
  updated_at  timestamptz not null default now()
);
insert into public.herald_agents (agent, service, variant, cost_class, health)
values ('vera', 'herald-vera-prod', 'lambda', 'medium', 'amber')
on conflict (agent) do nothing;

-- 8) Runs (SPEC-H 3.1). actor/on_behalf_of are text: peer calls carry 'agent:<name>'.
create table if not exists public.herald_runs (
  id             uuid primary key,
  agent          text not null,
  mode           text,
  task           text,
  parent_run_id  uuid,
  chain          text[] not null default '{}',
  actor_user_id  text,
  on_behalf_of   text,
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'requested' check (status in
                   ('requested','running','ok','refused','budget_exhausted','killed','error','timeout')),
  result         jsonb,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists herald_runs_agent on public.herald_runs (agent, created_at desc);
create index if not exists herald_runs_parent on public.herald_runs (parent_run_id);

-- 9) Per-person fact files (SPEC-E 3) - Vera's per-person source of truth
create table if not exists public.herald_fact_files (
  person_id   text primary key,
  data        jsonb not null,
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Seeds: roster locked 2026-07-10. Ashton + Jasmine from SPEC-E 3.1/3.2 verbatim,
-- Stephen (bio_submitted) + Anwar (draft_only) minimal shells.
insert into public.herald_fact_files (person_id, data, version) values
('ashton-couture', $jf$
{
  "person_id": "ashton-couture",
  "name": "Ashton Couture",
  "role_title": "Founder & CEO",
  "location": "Houston, TX",
  "approved_bio": "Ashton Couture is the Founder & CEO of Centurion Financial (founded 2021). With 28 years across software, banking technology, and commercial finance, he builds the infrastructure that makes capital access faster and cleaner. Earlier in his career he delivered systems to Microsoft, Credit Suisse, CH2M Hill (now Jacobs Engineering), and Chase.",
  "bio_approved": true,
  "verified_employers": [
    { "org": "Microsoft", "relationship": "client-delivery", "verified": true },
    { "org": "Credit Suisse", "relationship": "client-delivery", "verified": true },
    { "org": "CH2M Hill (now Jacobs Engineering)", "relationship": "client-delivery", "verified": true },
    { "org": "Chase", "relationship": "client-delivery", "verified": true },
    { "org": "Powered Labs", "relationship": "exit", "note": "One line only: 2010-2018, exited (F-005)", "verified": true },
    { "org": "Centurion Financial", "relationship": "employer", "note": "founded 2021", "verified": true }
  ],
  "education": [ { "school": "TODO", "degree": "TODO", "note": "not on the locked fact base or team page - do not publish education claims for Ashton until verified" } ],
  "do_not_say": [
    { "term": "AUM", "reason": "global VERA-T01; mirrored per mockup" },
    { "term": "raised $X", "pattern": "\\braised\\s+\\$?\\d", "reason": "global VERA-T02" },
    { "term": "$2B", "pattern": "\\$\\s*2\\s*(B\\b|Bn\\b|billion\\b)", "reason": "global VERA-T03" },
    { "term": "Sum Capital", "reason": "global VERA-T05" },
    { "term": "founded 1999", "reason": "global VERA-T04" }
  ],
  "approved_claims": [
    { "claim_id": "AC-01", "text": "28 years across software, banking technology, and commercial finance", "evidence": "kyc:fact-base + team page" },
    { "claim_id": "AC-02", "text": "Principal track record spanning debt placements and sponsor-side participation across more than a thousand transactions", "evidence": "team page pages/team.html (KYC-remediated framing)" },
    { "claim_id": "AC-03", "text": "Centurion Financial founded 2021", "evidence": "registry F-001" },
    { "claim_id": "AC-04", "text": "Powered Labs (2010-2018, exited)", "evidence": "registry F-005" }
  ],
  "approved_links": [
    { "kind": "linkedin", "url": "linkedin.com/in/ashtoncouture", "verified": true },
    { "kind": "crunchbase", "url": "crunchbase.com/person/ashton-couture", "verified": true },
    { "kind": "site", "url": "centurionfinancial.com", "verified": true }
  ],
  "headshot": { "status": "approved", "asset": "assets/team/ashton-couture.jpg" },
  "sign_off": { "signed_off": true, "signed_off_by": "Ashton Couture", "signed_off_at": "2026-07-07", "state": "publish_enabled_crawl" },
  "version": 1
}
$jf$::jsonb, 1),
('jasmine-amaso', $jf$
{
  "person_id": "jasmine-amaso",
  "name": "Jasmine Amaso",
  "role_title": "President - Global Capital Markets",
  "location": "Dubai & Houston",
  "approved_bio": "20+ years in institutional real assets and capital formation. Former JLL (BP Americas; GE Healthcare onboarding across 42 countries) and Head of Design & Construction at BBVA Compass; $1.28B+ in lender and investor term sheets across UAE real estate.",
  "bio_approved": true,
  "verified_employers": [
    { "org": "JLL", "relationship": "employer", "note": "BP Americas; GE Healthcare onboarding across 42 countries", "verified": true },
    { "org": "BBVA Compass", "relationship": "employer", "note": "Head of Design & Construction (former title - only publishable as former)", "verified": true },
    { "org": "Centurion Financial", "relationship": "employer", "verified": true }
  ],
  "education": [
    { "school": "Columbia University", "degree": "M.S., Sustainability Management", "note": "Green finance & ESG (per live entity home)" },
    { "school": "Rice University", "degree": "B.A. + professional degree, Architecture", "note": "LEED AP BD+C (per live entity home)" }
  ],
  "do_not_say": [
    { "term": "raised $1.28B", "pattern": "\\braised\\b.{0,30}1\\.28", "reason": "her figure is TERM SHEETS, not raised capital (F-004); global VERA-T02 also catches" }
  ],
  "approved_claims": [
    { "claim_id": "JA-01", "text": "20+ years in institutional real assets and capital formation", "evidence": "team page pages/team.html" },
    { "claim_id": "JA-02", "text": "$1.28B+ in lender and investor term sheets across UAE real estate", "evidence": "team page pages/team.html - note: term sheets framing is load-bearing" },
    { "claim_id": "JA-03", "text": "GE Healthcare onboarding across 42 countries (at JLL)", "evidence": "team page pages/team.html" }
  ],
  "approved_links": [
    { "kind": "site", "url": "centurionfinancial.com/team/jasmine-amaso.html", "verified": true },
    { "kind": "linkedin", "url": "TODO - confirm her LinkedIn URL at connect-flow", "verified": false },
    { "kind": "crunchbase", "url": "TODO - not yet created", "verified": false }
  ],
  "headshot": { "status": "approved", "asset": "assets/team/jasmine-amaso.jpg" },
  "sign_off": { "signed_off": true, "signed_off_by": "TODO - written record of Jasmine's one-line OK (launch doc still lists it as pre-flight)", "signed_off_at": null, "state": "publish_enabled_crawl" },
  "version": 1
}
$jf$::jsonb, 1),
('stephen-warren', $jf$
{
  "person_id": "stephen-warren",
  "name": "Stephen Warren",
  "role_title": "TODO - pending fact-file intake",
  "location": "",
  "approved_bio": "",
  "bio_approved": false,
  "verified_employers": [],
  "education": [],
  "do_not_say": [],
  "approved_claims": [],
  "approved_links": [],
  "headshot": { "status": "missing" },
  "sign_off": { "signed_off": false, "state": "bio_submitted" },
  "version": 1
}
$jf$::jsonb, 1),
('anwar-ferguson', $jf$
{
  "person_id": "anwar-ferguson",
  "name": "Anwar Ferguson",
  "role_title": "TODO - pending fact-file intake",
  "location": "",
  "approved_bio": "",
  "bio_approved": false,
  "verified_employers": [],
  "education": [],
  "do_not_say": [],
  "approved_claims": [],
  "approved_links": [],
  "headshot": { "status": "missing" },
  "sign_off": { "signed_off": false, "state": "draft_only" },
  "version": 1
}
$jf$::jsonb, 1)
on conflict (person_id) do nothing;

-- 10) RLS: capability-gated reads ('herald'), service-role writes (agents bypass RLS).
alter table public.herald_content_queue enable row level security;
alter table public.herald_approvals     enable row level security;
alter table public.herald_reports       enable row level security;
alter table public.herald_events        enable row level security;
alter table public.herald_controls      enable row level security;
alter table public.herald_schedules     enable row level security;
alter table public.herald_agents        enable row level security;
alter table public.herald_runs          enable row level security;
alter table public.herald_fact_files    enable row level security;

do $$
declare t text;
begin
  foreach t in array array['herald_content_queue','herald_approvals','herald_reports',
    'herald_events','herald_controls','herald_schedules','herald_agents','herald_runs','herald_fact_files']
  loop
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname='herald_read') then
      execute format(
        'create policy herald_read on public.%I for select to authenticated using (public.herald_has_capability(auth.uid(), %L))',
        t, 'herald');
    end if;
  end loop;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='herald_approvals' and policyname='herald_decide') then
    create policy herald_decide on public.herald_approvals for insert
      to authenticated with check (public.herald_has_capability(auth.uid(), 'herald'));
  end if;

  -- dashboard kill switch writes herald_controls directly (SPEC-H 5.6)
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='herald_controls' and policyname='herald_controls_insert') then
    create policy herald_controls_insert on public.herald_controls for insert
      to authenticated with check (public.herald_has_capability(auth.uid(), 'herald'));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='herald_controls' and policyname='herald_controls_update') then
    create policy herald_controls_update on public.herald_controls for update
      to authenticated
      using (public.herald_has_capability(auth.uid(), 'herald'))
      with check (public.herald_has_capability(auth.uid(), 'herald'));
  end if;
end $$;

-- 11) Hardening (advisor 0028): no anon/public RPC execution of the helper.
revoke execute on function public.herald_has_capability(uuid, text) from public;
revoke execute on function public.herald_has_capability(uuid, text) from anon;
revoke all on function public.herald_events_immutable() from public;
revoke all on function public.herald_events_immutable() from anon;
revoke all on function public.herald_events_immutable() from authenticated;
