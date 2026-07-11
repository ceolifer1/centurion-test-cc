-- HERALD Stage 4 coverage snapshots (SPEC-F: Sol coverage feeds the scorecard;
-- screen 05 KYC-Coverage Scorecard; Rhea reads the weekly delta). Additive +
-- idempotent. Applied 2026-07-11 as migration herald_coverage to CF dev
-- anvbfibhgokjtrwexaps -> test jdxuejbnecjugqlufhjp -> prod hruwrnbrlnitytneeafv.
-- Sol writes one row per (snapshot_date, person) plus a '_roster' rollup row;
-- the write is an idempotent upsert so a re-run on the same day overwrites, never
-- duplicates. Agents write via the service key (bypasses RLS); dashboard users
-- read gated on the herald capability (same helper as the other herald_* tables).

create table if not exists public.herald_coverage (
  id            uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  person        text not null,                  -- fact-file key, or '_roster' for the aggregate
  score         numeric not null default 0,     -- 0..100 presence %
  present       integer not null default 0,     -- # platforms present (person) / present cells (roster)
  total         integer not null default 0,     -- # platforms tracked (person) / cells (roster)
  platforms     jsonb   not null default '{}'::jsonb,  -- per-platform present map (person) / rollup extras (roster)
  gaps          jsonb   not null default '[]'::jsonb,   -- missing tracked platforms
  created_by    text    not null default 'sol',
  created_at    timestamptz not null default now(),
  unique (snapshot_date, person)
);

create index if not exists herald_coverage_person
  on public.herald_coverage (person, snapshot_date desc);
create index if not exists herald_coverage_date
  on public.herald_coverage (snapshot_date desc);

-- RLS: read gated on the herald capability (mirrors herald_reports/_events etc.).
alter table public.herald_coverage enable row level security;

-- Create the read policy only where the capability helper exists (it does on
-- every env that ran the earlier herald migrations). Where it does not yet
-- exist, RLS stays enabled with no authenticated policy = deny-all for users,
-- which is the safe default (the service role still writes/reads).
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'herald_has_capability'
  ) and not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'herald_coverage' and policyname = 'herald_read'
  ) then
    create policy herald_read on public.herald_coverage
      for select to authenticated
      using (public.herald_has_capability(auth.uid(), 'herald'));
  end if;
end $$;

-- No INSERT/UPDATE/DELETE policy for authenticated users: only the service role
-- (which Sol uses) writes snapshots, and the write is audited via herald_events.
