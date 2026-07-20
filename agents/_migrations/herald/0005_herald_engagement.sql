-- HERALD Stage 5 engagement queue (SPEC-D warm-only engagement + human-tap
-- follows; SPEC-H 4 Gia proposes / Vera clears / browser executes). Additive +
-- idempotent. Applied 2026-07-20 as migration herald_engagement to CF prod
-- hruwrnbrlnitytneeafv (dev anvbfibhgokjtrwexaps -> test jdxuejbnecjugqlufhjp ->
-- prod at the deploy window). Gia AUTHORS these rows:
--   * cleared warm like/comment (status 'cleared') for a downstream browser
--     executor (Piper family) to perform - Gia never runs a browser itself.
--   * human-tap follows (status 'human_tap') - follows are DISABLED for
--     automation (SPEC-D 4/6); they surface in the dashboard for one-tap human
--     execution and are NEVER auto-followed.
-- Cookie/session material is NEVER stored here (SPEC-C). Reads gated on the
-- herald capability; only the service role (which Gia uses) writes.

create table if not exists public.herald_engagement_queue (
  id            uuid primary key default gen_random_uuid(),
  person        text not null,
  platform      text not null check (platform in
                  ('linkedin_personal','linkedin_company','x','google_business','activity_page')),
  action_class  text not null check (action_class in
                  ('like','comment','reshare','reply','connect','follow')),
  target_ref    text,                              -- URL of the post/profile or the @handle
  target_kind   text,                              -- 'post' | 'profile' | 'account'
  warm_reason   text,                              -- connection|engaged_us|crm_partner|topic_graph (null for human-tap)
  body          text,                              -- comment copy (Vera-gated); null for like/follow
  vera_verdict  jsonb,
  status        text not null default 'proposed' check (status in
                  ('proposed','cleared','human_tap','executed','skipped','bounced')),
  tier          text not null check (tier in ('crawl','run')),
  created_by    text not null default 'gia',
  external_ref  text,
  executed_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists herald_engagement_person on public.herald_engagement_queue (person, status);
create index if not exists herald_engagement_cleared on public.herald_engagement_queue (created_at desc)
  where status = 'cleared';
create index if not exists herald_engagement_human_tap on public.herald_engagement_queue (created_at desc)
  where status = 'human_tap';

-- RLS: read gated on the herald capability (mirrors the other herald_* tables);
-- service-role writes bypass RLS. Where the capability helper is absent, RLS
-- stays enabled with no authenticated policy = deny-all for users (safe default).
alter table public.herald_engagement_queue enable row level security;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'herald_has_capability'
  ) and not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'herald_engagement_queue' and policyname = 'herald_read'
  ) then
    create policy herald_read on public.herald_engagement_queue
      for select to authenticated
      using (public.herald_has_capability(auth.uid(), 'herald'));
  end if;
end $$;

-- Register Gia in the agent registry (SPEC-H 7). health 'amber' until the Lambda
-- deploys (terraform apply herald-gia at the deploy window flips it to green).
insert into public.herald_agents (agent, service, variant, cost_class, health)
values ('gia', 'herald-gia-prod', 'lambda', 'low', 'amber')
on conflict (agent) do nothing;
