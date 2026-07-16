-- HERALD capability grants (prod-only; mandate_ops pattern). Applied 2026-07-11
-- as migration herald_capability_grants to CF prod hruwrnbrlnitytneeafv.
-- Grants the 'herald' capability to the two Run-tier principals (roster locked
-- 2026-07-10: principals Ashton + Jasmine; team Stephen + Anwar are draft-only
-- and get NO dashboard capability until signed).
update public.ecosystem_user_grants
set capabilities = (
  select jsonb_agg(distinct v)
  from jsonb_array_elements(coalesce(capabilities, '[]'::jsonb) || '["herald"]'::jsonb) as t(v)
),
updated_at = now()
where email in ('ceo@centurionfinancial.com', 'jasmine@centurionfinancial.com');
