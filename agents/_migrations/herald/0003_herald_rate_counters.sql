-- HERALD Stage 2 rate counters (SPEC-D section 7 - Vera's machine rules, enforced
-- by Piper/Gia). Additive + idempotent. Applied 2026-07-11 as migration
-- herald_rate_counters to CF dev anvbfibhgokjtrwexaps -> test jdxuejbnecjugqlufhjp
-- -> prod hruwrnbrlnitytneeafv. Per person, per platform, per action_class, per
-- window (day/week/burst, all America/Chicago - the key is computed by the agent).
-- reserve-then-act: `reserved` increments BEFORE the action; commit moves it to
-- `committed`; rollback releases it. A crash after reserve leaves the count high
-- (conservative), never low (SPEC-D 7.1: a crash can never undercount).

create table if not exists public.herald_rate_counters (
  person       text not null,
  platform     text not null,
  action_class text not null,
  window_key   text not null,
  window_type  text not null check (window_type in ('day','week','burst')),
  committed    integer not null default 0,
  reserved     integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (person, platform, action_class, window_key)
);
create index if not exists herald_rate_counters_lastact
  on public.herald_rate_counters (person, platform, updated_at desc) where committed > 0;

-- RLS: service-role only. Agents write via the service key (bypasses RLS); no
-- authenticated policy exists, so dashboard users read zero rows here (caps
-- utilization surfaces via herald_events caps.* rows, not this table).
alter table public.herald_rate_counters enable row level security;

-- Atomic reserve: increment reserved on every window (row locks), then verify
-- none exceeded its cap; if any did, release and deny. Holding the row locks for
-- the whole function prevents concurrent overcommit.
create or replace function public.herald_rate_reserve(
  p_person text, p_platform text, p_action_class text, p_windows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  w jsonb;
  v_used int;
  v_over_window text := null;
begin
  for w in select * from jsonb_array_elements(p_windows) loop
    insert into public.herald_rate_counters as c
      (person, platform, action_class, window_key, window_type, reserved, updated_at)
    values (p_person, p_platform, p_action_class, w->>'key', w->>'type', 1, now())
    on conflict (person, platform, action_class, window_key)
      do update set reserved = c.reserved + 1, updated_at = now();
  end loop;

  for w in select * from jsonb_array_elements(p_windows) loop
    select (committed + reserved) into v_used from public.herald_rate_counters
      where person = p_person and platform = p_platform
        and action_class = p_action_class and window_key = (w->>'key');
    if v_used > (w->>'cap')::int then
      v_over_window := w->>'type';
    end if;
  end loop;

  if v_over_window is not null then
    for w in select * from jsonb_array_elements(p_windows) loop
      update public.herald_rate_counters
        set reserved = greatest(reserved - 1, 0), updated_at = now()
        where person = p_person and platform = p_platform
          and action_class = p_action_class and window_key = (w->>'key');
    end loop;
    return jsonb_build_object('allowed', false, 'reason', 'cap', 'window', v_over_window);
  end if;

  return jsonb_build_object('allowed', true);
end
$fn$;

-- Commit: the action executed - move one reserved unit to committed per window.
create or replace function public.herald_rate_commit(
  p_person text, p_platform text, p_action_class text, p_windows jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare w jsonb;
begin
  for w in select * from jsonb_array_elements(p_windows) loop
    update public.herald_rate_counters
      set reserved = greatest(reserved - 1, 0), committed = committed + 1, updated_at = now()
      where person = p_person and platform = p_platform
        and action_class = p_action_class and window_key = (w->>'key');
  end loop;
end
$fn$;

-- Rollback: the action did NOT execute - release the reservation per window.
create or replace function public.herald_rate_rollback(
  p_person text, p_platform text, p_action_class text, p_windows jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare w jsonb;
begin
  for w in select * from jsonb_array_elements(p_windows) loop
    update public.herald_rate_counters
      set reserved = greatest(reserved - 1, 0), updated_at = now()
      where person = p_person and platform = p_platform
        and action_class = p_action_class and window_key = (w->>'key');
  end loop;
end
$fn$;

-- Hardening (advisor pattern): no anon/public/authenticated RPC execution - only
-- the service role (which the agents use) may reserve/commit/rollback.
revoke all on function public.herald_rate_reserve(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.herald_rate_commit(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.herald_rate_rollback(text, text, text, jsonb) from public, anon, authenticated;
