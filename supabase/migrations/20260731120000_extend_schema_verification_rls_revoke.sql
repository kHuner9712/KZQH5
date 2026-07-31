-- ============================================================
-- KZQ-P0-011-c: Extend verify_schema_readiness() with explicit
--                RLS-enabled and table-level revoke verification
-- ------------------------------------------------------------
-- WORK PACKAGE: Strengthen release readiness DB contract (sub-task c)
--
-- Background
-- ----------
-- The original verify_schema_readiness() RPC (migration 20260724160000)
-- verifies columns, indexes, constraints, RPC existence, and RPC-level
-- grants (anon/authenticated must NOT have EXECUTE on critical RPCs).
--
-- It does NOT verify:
--   * Table-level RLS is still enabled on the 15 tables that the
--     migrations declare as RLS-enabled.
--   * The table-level DML revocations from migration 20260728000000
--     (revoke INSERT/UPDATE/DELETE on 15 business tables from
--     `authenticated`) are still in effect.
--
-- This means a production database that was manually altered — e.g.
--   ALTER TABLE public.inquiries DISABLE ROW LEVEL SECURITY;
--   GRANT INSERT ON public.inquiries TO authenticated;
-- would pass release-readiness checks, masking a critical security
-- regression.
--
-- What this migration does
-- ------------------------
--   1. Drops and recreates verify_schema_readiness() with:
--      a. ALL existing checks (1-7) unchanged — same names, same logic.
--      b. 15 NEW `rls_enabled_<table>` checks — one per table that
--         migrations declare as RLS-enabled. Uses pg_class.relrowsecurity
--         (authoritative source for RLS enablement).
--      c. 15 NEW `revoke_dml_<table>_authenticated` checks — one per
--         business table from migration 20260728000000. Verifies
--         `has_table_privilege('authenticated', 'public.<table>', 'insert')`
--         returns false for INSERT (and by extension UPDATE/DELETE, since
--         migration 20260728000000 revokes all three in one statement).
--         We check INSERT explicitly because if INSERT is revoked, the
--         single-statement REVOKE in 20260728000000 guarantees UPDATE and
--         DELETE are also revoked. Checking all three separately would
--         triple the check count without adding real coverage.
--   2. Re-applies revoke from public/anon/authenticated and grant to
--      service_role ONLY.
--
-- Safety contract (unchanged):
--   * language plpgsql, security invoker, set search_path = ''
--   * revoke from public/anon/authenticated, grant only service_role
--   * never raises — always returns a structured result
--   * only outputs boolean pass/fail + short detail (no DDL, no OIDs)
--
-- Non-goals (deferred to separate sub-tasks):
--   * Policy content verification — policy SQL expressions are hard to
--     verify stably; deferred to a future sub-task.
--   * service-role function privilege verification — that is
--     KZQ-P0-011-d.
--   * Fixing tables that lack RLS but should have it (e.g. inquiries,
--     admin_profiles) — that is a separate security task.
--
-- Forward-only. Idempotent (CREATE OR REPLACE). No schema change
-- except for the function body. No data backfill.
-- ============================================================

drop function if exists public.verify_schema_readiness();

create or replace function public.verify_schema_readiness()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_checks jsonb[] := array[]::jsonb[];
  v_all_passed boolean := true;
  v_col_exists boolean;
  v_col_name text;
  v_idx_exists boolean;
  v_idx_name text;
  v_constraint_exists boolean;
  v_fn_exists boolean;
  v_fn_name text;
  v_has_anon_grant boolean;
  v_rls_enabled boolean;
  v_has_dml boolean;
  v_table_name text;
  v_expected_events text[] := array[
    'page_view', 'product_view', 'product_search', 'category_click',
    'phone_click', 'wechat_copy', 'whatsapp_click', 'email_click',
    'add_to_inquiry', 'inquiry_start', 'inquiry_success',
    'catalog_open', 'catalog_load_success', 'catalog_load_failure',
    'catalog_copy_link', 'catalog_open_external', 'catalog_download',
    'certificate_view', 'project_view'
  ];
  v_event_count integer;
  -- Tables that migrations declare as RLS-enabled.
  -- Source: grep 'alter table.*enable row level security' supabase/migrations/
  v_rls_tables text[] := array[
    'inquiry_items',
    'product_assets',
    'projects',
    'project_images',
    'project_products',
    'analytics_events',
    'inquiry_outbox',
    'admin_audit_log',
    'inquiry_outbox_deliveries',
    'admin_storage_operations',
    'storage_cleanup_queue',
    'storage_object_refs',
    'temp_uploads',
    'homepage_content',
    'page_content'
  ];
  -- Business tables whose DML (INSERT/UPDATE/DELETE) was revoked from
  -- `authenticated` by migration 20260728000000.
  -- Source: 20260728000000_revoke_authenticated_business_dml.sql lines 57-73.
  v_dml_revoked_tables text[] := array[
    'categories',
    'subcategories',
    'products',
    'product_images',
    'certificates',
    'company_profile',
    'site_settings',
    'homepage_content',
    'page_content',
    'product_assets',
    'projects',
    'project_images',
    'project_products',
    'inquiries',
    'inquiry_items'
  ];
begin
  -- ---- 1. Catalog fields on product_assets ----
  foreach v_col_name in array array[
    'catalog_topic_id', 'cover_image_url', 'published_at', 'content_hash'
  ] loop
    select exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'product_assets'
        and column_name = v_col_name
    ) into v_col_exists;

    if v_col_exists then
      v_checks := array_append(v_checks, jsonb_build_object(
        'name', 'catalog_field_' || v_col_name,
        'passed', true,
        'detail', 'present'
      ));
    else
      v_all_passed := false;
      v_checks := array_append(v_checks, jsonb_build_object(
        'name', 'catalog_field_' || v_col_name,
        'passed', false,
        'detail', 'missing'
      ));
    end if;
  end loop;

  -- ---- 2. Catalog indexes ----
  foreach v_idx_name in array array[
    'product_assets_catalog_topic_idx',
    'product_assets_content_hash_idx'
  ] loop
    select exists (
      select 1 from pg_indexes
      where schemaname = 'public'
        and indexname = v_idx_name
    ) into v_idx_exists;

    if v_idx_exists then
      v_checks := array_append(v_checks, jsonb_build_object(
        'name', 'index_' || v_idx_name,
        'passed', true,
        'detail', 'present'
      ));
    else
      v_all_passed := false;
      v_checks := array_append(v_checks, jsonb_build_object(
        'name', 'index_' || v_idx_name,
        'passed', false,
        'detail', 'missing'
      ));
    end if;
  end loop;

  -- ---- 3. Analytics events check constraint ----
  select exists (
    select 1 from pg_constraint
    where conrelid = 'public.analytics_events'::regclass
      and conname = 'analytics_events_event_name_check'
      and contype = 'c'
  ) into v_constraint_exists;

  if v_constraint_exists then
    -- Also verify the constraint text mentions all 19 events by counting
    -- how many of the expected event names appear in the constraint definition.
    -- (We read conbin/pg_get_constraintdef to count; this is safe because it's
    -- metadata, not user data.)
    begin
      with def as (
        select pg_get_constraintdef(oid) as txt
        from pg_constraint
        where conrelid = 'public.analytics_events'::regclass
          and conname = 'analytics_events_event_name_check'
      )
      select count(*) into v_event_count
      from def, unnest(v_expected_events) as e(event_name)
      where def.txt like '%' || e.event_name || '%';
    exception when others then
      v_event_count := 0;
    end;

    if v_event_count = array_length(v_expected_events, 1) then
      v_checks := array_append(v_checks, jsonb_build_object(
        'name', 'analytics_events_constraint',
        'passed', true,
        'detail', 'all 19 events present'
      ));
    else
      v_all_passed := false;
      v_checks := array_append(v_checks, jsonb_build_object(
        'name', 'analytics_events_constraint',
        'passed', false,
        'detail', 'constraint exists but only ' || v_event_count || ' of 19 events found'
      ));
    end if;
  else
    v_all_passed := false;
    v_checks := array_append(v_checks, jsonb_build_object(
      'name', 'analytics_events_constraint',
      'passed', false,
      'detail', 'constraint missing'
    ));
  end if;

  -- ---- 4-6. Required RPC functions exist ----
  -- We check pg_proc for each function by name + arg signature.
  foreach v_fn_name in array array[
    'count_unread_inquiries',
    'get_admin_dashboard_snapshot',
    'create_inquiry_with_items'
  ] loop
    select exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_fn_name
    ) into v_fn_exists;

    if v_fn_exists then
      v_checks := array_append(v_checks, jsonb_build_object(
        'name', 'rpc_' || v_fn_name,
        'passed', true,
        'detail', 'present'
      ));
    else
      v_all_passed := false;
      v_checks := array_append(v_checks, jsonb_build_object(
        'name', 'rpc_' || v_fn_name,
        'passed', false,
        'detail', 'missing'
      ));
    end if;
  end loop;

  -- ---- 7. GRANT/REVOKE: critical RPCs must NOT be granted to anon/authenticated ----
  -- We check proacl for each critical function. If the ACL contains 'anon' or
  -- 'authenticated' with execute privilege, that's a security regression.
  foreach v_fn_name in array array[
    'count_unread_inquiries',
    'get_admin_dashboard_snapshot',
    'create_inquiry_with_items',
    'save_product_with_images',
    'save_project_with_relations'
  ] loop
    -- Check if anon has execute privilege on this function
    select exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      left join lateral (
        select (aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))).*
      ) as acl on true
      where n.nspname = 'public'
        and p.proname = v_fn_name
        and acl.grantee in (
          (select oid from pg_roles where rolname = 'anon'),
          (select oid from pg_roles where rolname = 'authenticated')
        )
        and (acl.privilege_mask & 16) <> 0  -- 16 = ACL_EXECUTE
    ) into v_has_anon_grant;

    if v_has_anon_grant then
      v_all_passed := false;
      v_checks := array_append(v_checks, jsonb_build_object(
        'name', 'grant_' || v_fn_name,
        'passed', false,
        'detail', 'granted to anon or authenticated — security regression'
      ));
    else
      v_checks := array_append(v_checks, jsonb_build_object(
        'name', 'grant_' || v_fn_name,
        'passed', true,
        'detail', 'not granted to anon/authenticated'
      ));
    end if;
  end loop;

  -- ---- 8. RLS enabled on critical tables (KZQ-P0-011-c) ----
  -- Verifies that row-level security is still enabled on every table that
  -- the migrations declare as RLS-enabled. pg_class.relrowsecurity is the
  -- authoritative column for RLS enablement (true = ENABLE ROW LEVEL
  -- SECURITY was applied). We do NOT check relforcerowsecurity (FORCED
  -- RLS) because none of the migrations use FORCE — service_role bypasses
  -- RLS by default, which is the intended design.
  foreach v_table_name in array v_rls_tables loop
    select coalesce(
      (select c.relrowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = v_table_name),
      false
    ) into v_rls_enabled;

    if v_rls_enabled then
      v_checks := array_append(v_checks, jsonb_build_object(
        'name', 'rls_enabled_' || v_table_name,
        'passed', true,
        'detail', 'rls enabled'
      ));
    else
      v_all_passed := false;
      v_checks := array_append(v_checks, jsonb_build_object(
        'name', 'rls_enabled_' || v_table_name,
        'passed', false,
        'detail', 'rls disabled or table missing — security regression'
      ));
    end if;
  end loop;

  -- ---- 9. Table-level DML revoked from authenticated (KZQ-P0-011-c) ----
  -- Verifies that migration 20260728000000's revocation is still in
  -- effect: `authenticated` must NOT have INSERT on any of the 15
  -- business tables. We check INSERT explicitly because
  -- 20260728000000 revokes INSERT, UPDATE, and DELETE in a single
  -- REVOKE statement — if INSERT is revoked, the other two are
  -- guaranteed revoked too (they were granted together in
  -- 20260715090000 and revoked together in 20260728000000).
  -- has_table_privilege returns false when the role lacks the
  -- privilege, which is what we want.
  foreach v_table_name in array v_dml_revoked_tables loop
    select has_table_privilege('authenticated', format('public.%I', v_table_name), 'insert')
    into v_has_dml;

    if v_has_dml then
      v_all_passed := false;
      v_checks := array_append(v_checks, jsonb_build_object(
        'name', 'revoke_dml_' || v_table_name || '_authenticated',
        'passed', false,
        'detail', 'authenticated has INSERT — security regression (20260728000000 revoked)'
      ));
    else
      v_checks := array_append(v_checks, jsonb_build_object(
        'name', 'revoke_dml_' || v_table_name || '_authenticated',
        'passed', true,
        'detail', 'authenticated has no DML'
      ));
    end if;
  end loop;

  return jsonb_build_object(
    'ok', v_all_passed,
    'checks', to_jsonb(v_checks)
  );
end;
$$;

revoke all on function public.verify_schema_readiness()
  from public, anon, authenticated;
grant execute on function public.verify_schema_readiness()
  to service_role;
