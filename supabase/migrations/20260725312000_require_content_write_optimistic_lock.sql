-- ============================================================
-- Migration 20260725312000
-- Require optimistic locks on content updates (verification gate)
-- ============================================================
-- Round-4 hardening. The strict optimistic lock requirement is:
--
--   For each content-write RPC, when `p_id is not null` (UPDATE
--   path), `p_expected_updated_at` MUST be non-null. A NULL
--   timestamp on an update MUST raise SQLSTATE 22004. A stale
--   timestamp MUST raise SQLSTATE 40P01.
--
-- Covered RPCs (5):
--   * save_product_with_images_and_audit   -- enforced by 20260725311000
--   * save_project_with_relations          -- enforced by 20260725311000
--                                            (called by save_project_with_relations_and_audit)
--   * save_company_profile_with_audit      -- enforced by 20260725230000
--   * save_site_settings_with_audit        -- enforced by 20260725230000
--   * save_homepage_content_with_audit     -- enforced by 20260725230000
--
-- This migration does NOT redefine those functions. Instead it:
--   1. Adds a verification helper that inspects each function's
--      source via pg_get_functiondef and confirms the 22004 raise
--      is present on the UPDATE path. This catches regressions
--      where a future CREATE OR REPLACE might silently drop the
--      check.
--   2. Runs the verification at migration time as a runtime
--      assertion. If any RPC is missing the check, the migration
--      itself fails — which is the correct signal that the
--      protection has been removed.
--
-- Forward-only. No existing migration is modified.
-- ============================================================


-- ============================================================
-- A. verify_optimistic_lock_enforcement() helper
-- ============================================================
-- Returns one row per RPC that MUST enforce the strict optimistic
-- lock. Each row contains:
--   function_name  : the RPC name
--   enforces_22004 : boolean, true if the function source contains
--                    a 22004 raise on the UPDATE path
--
-- A NULL result for enforces_22004 means the function could not be
-- introspected (should never happen on a healthy schema).
--
-- Security: STABLE, SECURITY INVOKER, search_path = ''. Callers
-- need EXECUTE (granted to service_role only).
-- ============================================================
create or replace function public.verify_optimistic_lock_enforcement()
returns table(function_name text, enforces_22004 boolean)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_fn text[] := array[
    'save_product_with_images_and_audit',
    'save_project_with_relations',
    'save_company_profile_with_audit',
    'save_site_settings_with_audit',
    'save_homepage_content_with_audit'
  ];
  v_name text;
  v_src text;
  v_enforces boolean;
begin
  foreach v_name in array v_fn loop
    select pg_get_functiondef(p.oid)
      into v_src
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_name;

    if v_src is null then
      -- Function missing entirely — verifier will catch this separately.
      return query select v_name, null::boolean;
      continue;
    end if;

    -- The strict check raises 22004 when p_expected_updated_at is
    -- null on the UPDATE path. We look for both the errcode and
    -- the parameter name to avoid false positives from unrelated
    -- 22004 raises.
    v_enforces := (
      v_src like '%22004%'
      and v_src like '%p_expected_updated_at is null%'
    );

    return query select v_name, v_enforces;
  end loop;
end;
$$;

revoke all on function public.verify_optimistic_lock_enforcement()
  from public, anon, authenticated;
grant execute on function public.verify_optimistic_lock_enforcement()
  to service_role;


-- ============================================================
-- B. Runtime assertion — all 5 RPCs MUST enforce the check
-- ============================================================
-- This DO block runs at migration time. If any RPC is missing the
-- strict 22004 raise, the migration fails — which blocks CI and
-- prevents the protection from being silently removed.
do $$
declare
  v_name text;
  v_enforces boolean;
  v_missing text[];
begin
  v_missing := array[]::text[];
  for v_name, v_enforces in
    select function_name, enforces_22004
      from public.verify_optimistic_lock_enforcement()
  loop
    if v_enforces is not true then
      v_missing := array_append(v_missing, v_name);
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception
      '20260725312000 FAILED: these RPCs do not enforce strict optimistic lock (22004 on NULL p_expected_updated_at): %',
      array_to_string(v_missing, ', ')
      using errcode = 'P0001';
  end if;
end;
$$;


-- ============================================================
-- End of migration
-- ============================================================
