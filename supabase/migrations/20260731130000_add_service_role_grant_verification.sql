-- ============================================================
-- KZQ-P0-011-d: Verify service_role EXECUTE privilege on
--                critical service-role-only RPCs
-- ------------------------------------------------------------
-- WORK PACKAGE: Strengthen release readiness DB contract (sub-task d)
--
-- Background
-- ----------
-- The verify_schema_readiness() RPC (as extended by 20260731120000)
-- verifies that anon/authenticated do NOT have EXECUTE on 5 critical
-- RPCs (section 7 — negative check). It does NOT verify the
-- corresponding positive contract: service_role MUST have EXECUTE on
-- those same RPCs plus verify_schema_readiness itself.
--
-- This means a production database where the service_role grant was
-- accidentally revoked — e.g. by a migration ordering bug, a manual
-- `REVOKE EXECUTE ON ... FROM service_role`, or a restore that lost
-- grants — would pass release-readiness checks, but the application
-- would fail at runtime with 403 / permission denied.
--
-- What this migration does
-- ------------------------
--   1. CREATE OR REPLACE verify_schema_readiness() with:
--      a. ALL existing checks (1-9) unchanged — same names, same logic.
--      b. 6 NEW `grant_service_role_<fn>` checks — one per critical
--         service-role-only RPC. Resolves each function by its
--         canonical signature via `to_regprocedure('public.fn(sig)')`
--         (handles overloads correctly), then checks
--         `has_function_privilege('service_role', <oid>, 'execute')`.
--   2. Re-applies revoke from public/anon/authenticated and grant to
--      service_role ONLY.
--
-- The 6 critical RPCs verified (all service_role-only by design):
--   * count_unread_inquiries()
--   * get_admin_dashboard_snapshot()
--   * create_inquiry_with_items(jsonb, jsonb, uuid)  -- 3-arg current
--   * save_product_with_images(uuid, jsonb, jsonb, timestamptz)
--   * save_project_with_relations(uuid, jsonb, jsonb, jsonb, timestamptz)
--   * verify_schema_readiness()  -- self-verify (bootstrap check)
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
--   * Verifying ALL service_role-only functions (only the 6 critical
--     ones are checked; lesser-used RPCs are deferred).
--
-- Forward-only. Idempotent (CREATE OR REPLACE). No schema change
-- except for the function body. No data backfill.
-- ============================================================

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
  -- Business tables whose DML was revoked from `authenticated`
  -- by migration 20260728000000.
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
  -- KZQ-P0-011-d: service_role EXECUTE verification state
  v_fn_oid regprocedure;
  v_has_service_role_grant boolean;
  v_fn_spec text[];
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
  foreach v_fn_name in array array[
    'count_unread_inquiries',
    'get_admin_dashboard_snapshot',
    'create_inquiry_with_items',
    'save_product_with_images',
    'save_project_with_relations'
  ] loop
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

  -- ---- 10. service_role EXECUTE on critical service-role-only RPCs (KZQ-P0-011-d) ----
  -- Verifies that service_role still has EXECUTE on the 6 critical RPCs
  -- that are service_role-only by design. If the grant is accidentally
  -- revoked (migration ordering bug, manual REVOKE, restore that lost
  -- grants), the application cannot function — release-readiness must
  -- BLOCK.
  --
  -- We resolve each function by its canonical signature via
  -- to_regprocedure('public.fn(sig)') to handle overloads correctly
  -- (e.g. create_inquiry_with_items has 2-arg and 3-arg versions),
  -- then check has_function_privilege('service_role', <oid>, 'execute').
  --
  -- Note: has_function_privilege(role, oid, priv) queries the ACL as
  -- seen by the current user. In the release-readiness context the RPC
  -- is invoked by service_role, which can inspect its own privileges.
  foreach v_fn_spec in array array[
    ['count_unread_inquiries', 'count_unread_inquiries()'],
    ['get_admin_dashboard_snapshot', 'get_admin_dashboard_snapshot()'],
    ['create_inquiry_with_items', 'create_inquiry_with_items(jsonb, jsonb, uuid)'],
    ['save_product_with_images', 'save_product_with_images(uuid, jsonb, jsonb, timestamptz)'],
    ['save_project_with_relations', 'save_project_with_relations(uuid, jsonb, jsonb, jsonb, timestamptz)'],
    ['verify_schema_readiness', 'verify_schema_readiness()']
  ] loop
    v_fn_oid := to_regprocedure('public.' || v_fn_spec[2]);

    if v_fn_oid is null then
      -- Function with this exact signature is missing. The existence
      -- checks in sections 4-6 already cover the first 3 by name; the
      -- last 3 (save_*, verify_schema_readiness) are implicitly checked
      -- here. Report as BLOCK — the function must exist with the
      -- expected signature.
      v_all_passed := false;
      v_checks := array_append(v_checks, jsonb_build_object(
        'name', 'grant_service_role_' || v_fn_spec[1],
        'passed', false,
        'detail', 'function not found with expected signature'
      ));
    else
      select has_function_privilege('service_role', v_fn_oid::text, 'execute')
      into v_has_service_role_grant;

      if v_has_service_role_grant then
        v_checks := array_append(v_checks, jsonb_build_object(
          'name', 'grant_service_role_' || v_fn_spec[1],
          'passed', true,
          'detail', 'service_role has execute'
        ));
      else
        v_all_passed := false;
        v_checks := array_append(v_checks, jsonb_build_object(
          'name', 'grant_service_role_' || v_fn_spec[1],
          'passed', false,
          'detail', 'service_role lacks execute — application cannot function'
        ));
      end if;
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
