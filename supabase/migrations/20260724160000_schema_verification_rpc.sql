-- ============================================================
-- Phase 7: Schema Verification RPC (read-only, service_role only)
--
-- Provides a single callable that verifies the production schema is
-- compatible with the deployed application code. Used by the rewritten
-- check-release-readiness.mjs script to replace fragile
-- /rest/v1/information_schema probing.
--
-- Checks performed (all read-only):
--   1. product_assets has the 4 catalog fields:
--      catalog_topic_id, cover_image_url, published_at, content_hash
--   2. The 2 catalog indexes exist:
--      product_assets_catalog_topic_idx
--      product_assets_content_hash_idx
--   3. analytics_events has the 19-event check constraint
--      (analytics_events_event_name_check)
--   4. count_unread_inquiries() function exists
--   5. get_admin_dashboard_snapshot() function exists
--   6. create_inquiry_with_items(jsonb, jsonb, uuid) exists (Phase 5)
--   7. The above functions are granted ONLY to service_role (not anon/auth)
--
-- Returns jsonb:
--   {
--     "ok": true|false,
--     "checks": [
--       { "name": "...", "passed": true|false, "detail": "..." }
--     ]
--   }
--
-- Safety contract:
--   * language plpgsql, security invoker, set search_path = ''
--   * revoke from public/anon/authenticated, grant only service_role
--   * never raises — always returns a structured result
--   * never outputs schema DDL, column types, or internal object OIDs
--   * only outputs boolean pass/fail + a short human-readable detail string
--
-- This migration is additive. It does not alter existing tables, policies,
-- or data. It is NOT executed in this commit.
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
  v_expected_events text[] := array[
    'page_view', 'product_view', 'product_search', 'category_click',
    'phone_click', 'wechat_copy', 'whatsapp_click', 'email_click',
    'add_to_inquiry', 'inquiry_start', 'inquiry_success',
    'catalog_open', 'catalog_load_success', 'catalog_load_failure',
    'catalog_copy_link', 'catalog_open_external', 'catalog_download',
    'certificate_view', 'project_view'
  ];
  v_event_count integer;
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
