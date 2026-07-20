-- HERALD Stage 5 session-vault consent ledger (SPEC-C section 7). Additive +
-- idempotent. Applied 2026-07-20 as migration herald_consent_ledger to CF prod
-- hruwrnbrlnitytneeafv (dev anvbfibhgokjtrwexaps -> test jdxuejbnecjugqlufhjp ->
-- prod at the deploy window). This is the compliance answer to "prove this person
-- consented to this automation on this date with this scope." A row is written
-- PENDING_CONSENT by herald-vault BEFORE any session secret exists (SPEC-C 3.2),
-- flipped ACTIVE by the capture task, and REVOKED on teardown. Re-consent appends
-- a NEW row (history preserved). Cookie/session material is NEVER stored here -
-- only who/what/when/scope (SPEC-C T3).

create table if not exists public.herald_consent_ledger (
  id               uuid primary key default gen_random_uuid(),
  person           text not null,
  platform         text not null check (platform in ('linkedin_personal','linkedin_company','x')),
  granted_at       timestamptz not null default now(),
  granted_by       text not null,
  scope            jsonb not null default '[]'::jsonb,     -- capability strings as granted (SPEC-C 7)
  status           text not null default 'PENDING_CONSENT' check (status in
                     ('PENDING_CONSENT','ACTIVE','ABANDONED','REVOKED','EXPIRED')),
  capture_task_arn text,
  revoked_at       timestamptz,
  revoked_by       text,
  created_at       timestamptz not null default now()
);

create index if not exists herald_consent_person on public.herald_consent_ledger (person, platform, granted_at desc);
create index if not exists herald_consent_active on public.herald_consent_ledger (person, platform)
  where status = 'ACTIVE';

-- RLS: read gated on the herald capability (mirrors the other herald_* tables);
-- only the service role (which herald-vault uses) writes. Where the capability
-- helper is absent, RLS stays enabled with no authenticated policy = deny-all.
alter table public.herald_consent_ledger enable row level security;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'herald_has_capability'
  ) and not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'herald_consent_ledger' and policyname = 'herald_read'
  ) then
    create policy herald_read on public.herald_consent_ledger
      for select to authenticated
      using (public.herald_has_capability(auth.uid(), 'herald'));
  end if;
end $$;

-- Register herald-vault in the agent registry (SPEC-H 7). health 'amber' until
-- the Lambda + per-person CMKs deploy at the next key window.
insert into public.herald_agents (agent, service, variant, cost_class, health)
values ('vault', 'herald-vault-prod', 'lambda', 'low', 'amber')
on conflict (agent) do nothing;
