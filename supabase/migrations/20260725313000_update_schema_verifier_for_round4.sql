-- ============================================================
-- Migration 20260725313000
-- Update Schema Verifier catalog for round-4 RPCs
-- ============================================================
-- Round-4 introduced these new functions:
--
--   * get_managed_storage_host()               -- 20260725310000
--       Reads the trusted managed-storage host from site_settings.
--
--   * register_managed_storage_ref_structured( -- 20260725310000
--       text, uuid, text, text, text, text, text, bigint, text)
--       Structured ref registration (no URL parsing).
--
--   * verify_optimistic_lock_enforcement()     -- 20260725312000
--       Introspects content-write RPCs and confirms the strict
--       22004 raise is present on the UPDATE path.
--
-- This migration:
--   1. Replaces list_required_schema_objects() to add the new
--      functions to the catalog.
--   2. Replaces verify_required_schema() to add the new functions
--      to the v_security_fn array (ACL check) and to add
--      register_managed_storage_ref_structured to the
--      v_single_overload_fn array (overload gate).
--
-- The return type of both functions is unchanged:
--   list_required_schema_objects() -> table(object_name text, object_type text)
--   verify_required_schema()       -> table(missing text)
--
-- Forward-only. No existing migration is modified.
-- ============================================================


-- ============================================================
-- A. list_required_schema_objects — ADD new functions
-- ============================================================
create or replace function public.list_required_schema_objects()
returns table(object_name text, object_type text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  -- ---- Tables ----
  return query select 'admin_profiles', 'table'::text;
  return query select 'admin_audit_log', 'table'::text;
  return query select 'storage_cleanup_queue', 'table'::text;
  return query select 'storage_object_refs', 'table'::text;
  return query select 'admin_storage_operations', 'table'::text;
  return query select 'product_assets', 'table'::text;
  return query select 'certificates', 'table'::text;
  return query select 'company_profile', 'table'::text;
  return query select 'site_settings', 'table'::text;
  return query select 'homepage_content', 'table'::text;
  return query select 'page_content', 'table'::text;
  return query select 'categories', 'table'::text;
  return query select 'subcategories', 'table'::text;
  return query select 'projects', 'table'::text;
  return query select 'project_images', 'table'::text;
  return query select 'project_products', 'table'::text;

  -- ---- Columns (catalog asset publish state machine) ----
  return query select 'product_assets.catalog_topic_id', 'column'::text;
  return query select 'product_assets.cover_image_url', 'column'::text;
  return query select 'product_assets.published_at', 'column'::text;
  return query select 'product_assets.content_hash', 'column'::text;
  return query select 'product_assets.source_bucket', 'column'::text;
  return query select 'product_assets.source_object_path', 'column'::text;
  return query select 'product_assets.published_bucket', 'column'::text;
  return query select 'product_assets.published_object_path', 'column'::text;
  return query select 'product_assets.publish_status', 'column'::text;
  return query select 'product_assets.publish_token', 'column'::text;
  return query select 'product_assets.access_level', 'column'::text;
  return query select 'product_assets.source_type', 'column'::text;
  return query select 'product_assets.authorization_status', 'column'::text;
  return query select 'product_assets.candidate_public_bucket', 'column'::text;
  return query select 'product_assets.candidate_public_path', 'column'::text;
  return query select 'product_assets.candidate_sha256', 'column'::text;
  return query select 'product_assets.last_publish_error_code', 'column'::text;

  -- ---- Columns (certificate publish state machine) ----
  return query select 'certificates.source_bucket', 'column'::text;
  return query select 'certificates.source_object_path', 'column'::text;
  return query select 'certificates.published_bucket', 'column'::text;
  return query select 'certificates.published_object_path', 'column'::text;
  return query select 'certificates.publish_status', 'column'::text;
  return query select 'certificates.publish_token', 'column'::text;
  return query select 'certificates.access_level', 'column'::text;
  return query select 'certificates.source_type', 'column'::text;
  return query select 'certificates.authorization_status', 'column'::text;
  return query select 'certificates.candidate_public_bucket', 'column'::text;
  return query select 'certificates.candidate_public_path', 'column'::text;
  return query select 'certificates.candidate_sha256', 'column'::text;
  return query select 'certificates.last_publish_error_code', 'column'::text;

  -- ---- Columns (storage_cleanup_queue audit saga) ----
  return query select 'storage_cleanup_queue.storage_operation_id', 'column'::text;
  return query select 'storage_cleanup_queue.final_status', 'column'::text;

  -- ---- Columns (round-4 site_settings.managed_storage_host) ----
  return query select 'site_settings.managed_storage_host', 'column'::text;

  -- ---- Functions (storage cleanup lifecycle) ----
  return query select 'enqueue_storage_cleanup', 'function'::text;
  return query select 'claim_storage_cleanup', 'function'::text;
  return query select 'complete_storage_cleanup(uuid, uuid, boolean, text, uuid, text)', 'function'::text;
  return query select 'check_storage_object_referenced', 'function'::text;
  return query select 'extract_managed_storage_path', 'function'::text;
  return query select 'enqueue_managed_storage_cleanup', 'function'::text;
  return query select 'record_storage_operation_started', 'function'::text;
  return query select 'complete_storage_operation', 'function'::text;
  return query select 'claim_storage_audit_reconcile', 'function'::text;
  return query select 'complete_storage_audit_reconcile', 'function'::text;
  return query select 'extract_managed_storage_path_strict', 'function'::text;
  return query select 'register_storage_object_ref', 'function'::text;
  return query select 'register_managed_storage_ref_from_url', 'function'::text;
  return query select 'mark_storage_object_refs_deleted', 'function'::text;
  return query select 'mark_storage_object_refs_pending_delete', 'function'::text;

  -- ---- Functions (round-4 strict managed storage identity) ----
  return query select 'get_managed_storage_host', 'function'::text;
  return query select 'register_managed_storage_ref_structured', 'function'::text;

  -- ---- Functions (round-4 optimistic lock verification) ----
  return query select 'verify_optimistic_lock_enforcement', 'function'::text;

  -- ---- Functions (catalog asset publish) ----
  return query select 'claim_catalog_asset_publish', 'function'::text;
  return query select 'finalize_catalog_asset_publish', 'function'::text;
  return query select 'recover_stale_catalog_publish', 'function'::text;
  return query select 'authorize_product_asset', 'function'::text;
  return query select 'save_product_asset_draft', 'function'::text;
  return query select 'update_product_asset_metadata', 'function'::text;
  return query select 'delete_product_asset_with_cleanup', 'function'::text;
  return query select 'unpublish_catalog_asset', 'function'::text;

  -- ---- Functions (certificate publish) ----
  return query select 'save_certificate_draft', 'function'::text;
  return query select 'update_certificate_metadata', 'function'::text;
  return query select 'authorize_certificate', 'function'::text;
  return query select 'claim_certificate_publish', 'function'::text;
  return query select 'finalize_certificate_publish', 'function'::text;
  return query select 'unpublish_certificate', 'function'::text;
  return query select 'delete_certificate_with_cleanup', 'function'::text;
  return query select 'recover_stale_certificate_publish', 'function'::text;

  -- ---- Functions (transactional business writes) ----
  return query select 'save_product_with_images_and_audit', 'function'::text;
  return query select 'bulk_update_products_with_audit', 'function'::text;
  return query select 'bulk_delete_products_with_audit', 'function'::text;
  return query select 'save_project_with_relations', 'function'::text;
  return query select 'save_project_with_relations_and_audit', 'function'::text;
  return query select 'delete_project_with_audit', 'function'::text;

  -- ---- Functions (CMS content) ----
  return query select 'save_company_profile_with_audit', 'function'::text;
  return query select 'save_site_settings_with_audit', 'function'::text;
  return query select 'save_homepage_content_with_audit', 'function'::text;
  return query select 'save_page_content_with_audit', 'function'::text;
  return query select 'save_category_with_audit', 'function'::text;
  return query select 'delete_category_with_audit', 'function'::text;
  return query select 'save_subcategory_with_audit', 'function'::text;
  return query select 'delete_subcategory_with_audit', 'function'::text;

  -- ---- Functions (schema verification) ----
  return query select 'verify_schema_readiness', 'function'::text;
  return query select 'list_required_schema_objects', 'function'::text;
  return query select 'verify_required_schema', 'function'::text;

  return;
end;
$$;

revoke all on function public.list_required_schema_objects()
  from public, anon, authenticated;
grant execute on function public.list_required_schema_objects()
  to service_role;


-- ============================================================
-- B. verify_required_schema — ADD new functions to ACL check
-- ============================================================
-- The function body is copied from 20260725262000 with two
-- additions to v_security_fn:
--   * get_managed_storage_host
--   * register_managed_storage_ref_structured
--   * verify_optimistic_lock_enforcement
--
-- And one addition to v_single_overload_fn:
--   * register_managed_storage_ref_structured
--   * verify_optimistic_lock_enforcement
--
-- The return type remains TABLE(missing text).
-- ============================================================
create or replace function public.verify_required_schema()
returns table(missing text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_obj text;
  v_typ text;
  v_table_name text;
  v_col_name text;
  v_fn_name text;
  v_fn_sig text;
  v_paren_pos integer;
  v_table_exists boolean;
  v_col_exists boolean;
  v_fn_exists boolean;
  v_idx_exists boolean;
  v_constraint_exists boolean;
  v_regproc regprocedure;
  v_proc_count integer;
  v_service_role_oid oid;
  v_anon_oid oid;
  v_authenticated_oid oid;
  v_service_role_ok boolean;
  v_public_ok boolean;
  v_anon_ok boolean;
  v_authenticated_ok boolean;
  v_proacl aclitem[];
  v_acl_row record;
  v_security_fn text[] := array[
    'complete_storage_cleanup',
    'claim_storage_cleanup',
    'enqueue_storage_cleanup',
    'check_storage_object_referenced',
    'extract_managed_storage_path',
    'enqueue_managed_storage_cleanup',
    'record_storage_operation_started',
    'complete_storage_operation',
    'claim_storage_audit_reconcile',
    'complete_storage_audit_reconcile',
    'extract_managed_storage_path_strict',
    'get_managed_storage_host',
    'register_managed_storage_ref_structured',
    'register_storage_object_ref',
    'mark_storage_object_refs_deleted',
    'mark_storage_object_refs_pending_delete',
    'claim_catalog_asset_publish',
    'finalize_catalog_asset_publish',
    'recover_stale_catalog_publish',
    'authorize_product_asset',
    'save_product_asset_draft',
    'update_product_asset_metadata',
    'delete_product_asset_with_cleanup',
    'unpublish_catalog_asset',
    'save_certificate_draft',
    'update_certificate_metadata',
    'authorize_certificate',
    'claim_certificate_publish',
    'finalize_certificate_publish',
    'unpublish_certificate',
    'delete_certificate_with_cleanup',
    'recover_stale_certificate_publish',
    'save_product_with_images_and_audit',
    'bulk_update_products_with_audit',
    'bulk_delete_products_with_audit',
    'save_project_with_relations',
    'save_project_with_relations_and_audit',
    'delete_project_with_audit',
    'save_company_profile_with_audit',
    'save_site_settings_with_audit',
    'save_homepage_content_with_audit',
    'save_page_content_with_audit',
    'save_category_with_audit',
    'delete_category_with_audit',
    'save_subcategory_with_audit',
    'delete_subcategory_with_audit',
    'verify_optimistic_lock_enforcement',
    'verify_schema_readiness',
    'list_required_schema_objects',
    'verify_required_schema'
  ];
  v_single_overload_fn text[] := array[
    'complete_storage_cleanup',
    'register_storage_object_ref',
    'register_managed_storage_ref_structured',
    'mark_storage_object_refs_deleted',
    'mark_storage_object_refs_pending_delete',
    'enqueue_storage_cleanup',
    'claim_storage_cleanup',
    'finalize_catalog_asset_publish',
    'finalize_certificate_publish',
    'unpublish_catalog_asset',
    'unpublish_certificate',
    'delete_product_asset_with_cleanup',
    'delete_certificate_with_cleanup',
    'verify_optimistic_lock_enforcement',
    'verify_required_schema',
    'list_required_schema_objects'
  ];
begin
  select oid into v_service_role_oid from pg_roles where rolname = 'service_role';
  select oid into v_anon_oid from pg_roles where rolname = 'anon';
  select oid into v_authenticated_oid from pg_roles where rolname = 'authenticated';

  -- ---- Existence checks (table / column / function / index / constraint) ----
  for v_obj, v_typ in
    select object_name, object_type
      from public.list_required_schema_objects()
  loop
    case v_typ
      when 'table' then
        select exists (
          select 1 from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and c.relname = v_obj
              and c.relkind = 'r'
        ) into v_table_exists;
        if not v_table_exists then
          return query select v_obj;
        end if;

      when 'column' then
        v_table_name := split_part(v_obj, '.', 1);
        v_col_name := split_part(v_obj, '.', 2);
        select exists (
          select 1 from information_schema.columns
            where table_schema = 'public'
              and table_name = v_table_name
              and column_name = v_col_name
        ) into v_col_exists;
        if not v_col_exists then
          return query select v_obj;
        end if;

      when 'function' then
        v_paren_pos := position('(' in v_obj);
        if v_paren_pos > 0 then
          v_fn_name := left(v_obj, v_paren_pos - 1);
          v_fn_sig := substring(v_obj from v_paren_pos);
          begin
            execute format('select to_regprocedure(%L)', 'public.' || v_fn_name || v_fn_sig)
              into v_regproc;
          exception when others then
            v_regproc := null;
          end;

          if v_regproc is null then
            return query select v_obj;
          end if;
        else
          v_fn_name := v_obj;
          select exists (
            select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and p.proname = v_fn_name
          ) into v_fn_exists;
          if not v_fn_exists then
            return query select v_obj;
          end if;
        end if;

      when 'index' then
        select exists (
          select 1 from pg_indexes
            where schemaname = 'public'
              and indexname = v_obj
        ) into v_idx_exists;
        if not v_idx_exists then
          return query select v_obj;
        end if;

      when 'constraint' then
        select exists (
          select 1 from pg_constraint
            where connamespace = 'public'::regnamespace
              and conname = v_obj
        ) into v_constraint_exists;
        if not v_constraint_exists then
          return query select v_obj;
        end if;

      else
        return query select v_obj;
    end case;
  end loop;

  -- ---- Overload-count gate for curated functions ----
  foreach v_fn_name in array v_single_overload_fn loop
    select count(*)
      into v_proc_count
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_fn_name;
    if v_proc_count <> 1 then
      return query select 'overload:' || v_fn_name || ':' || v_proc_count::text;
    end if;
  end loop;

  -- ---- Security-critical GRANT/REVOKE checks ----
  foreach v_fn_name in array v_security_fn loop
    for v_regproc in
      select p.oid::regprocedure
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = v_fn_name
    loop
      -- 1. service_role must have EXECUTE.
      if v_service_role_oid is not null then
        select has_function_privilege(v_service_role_oid, v_regproc::oid, 'EXECUTE')
          into v_service_role_ok;
        if not coalesce(v_service_role_ok, false) then
          return query select 'grant:service_role:' || v_fn_name;
        end if;
      end if;

      -- 2. PUBLIC (grantee=0) must NOT have EXECUTE.
      v_public_ok := false;
      select p.proacl into v_proacl
        from pg_proc p
        where p.oid = v_regproc::oid;
      if v_proacl is null then
        v_public_ok := true;
      else
        for v_acl_row in select * from aclexplode(v_proacl) loop
          if v_acl_row.grantee = 0 and v_acl_row.privilege_type = 'EXECUTE' then
            v_public_ok := true;
          end if;
        end loop;
      end if;
      if v_public_ok then
        return query select 'grant:public:' || v_fn_name;
      end if;

      -- 3. anon must NOT have EXECUTE (only checked if the role exists).
      if v_anon_oid is not null then
        select has_function_privilege(v_anon_oid, v_regproc::oid, 'EXECUTE')
          into v_anon_ok;
        if coalesce(v_anon_ok, false) then
          return query select 'grant:anon:' || v_fn_name;
        end if;
      end if;

      -- 4. authenticated must NOT have EXECUTE (only checked if the role exists).
      if v_authenticated_oid is not null then
        select has_function_privilege(v_authenticated_oid, v_regproc::oid, 'EXECUTE')
          into v_authenticated_ok;
        if coalesce(v_authenticated_ok, false) then
          return query select 'grant:authenticated:' || v_fn_name;
        end if;
      end if;
    end loop;
  end loop;

  return;
end;
$$;

revoke all on function public.verify_required_schema()
  from public, anon, authenticated;
grant execute on function public.verify_required_schema()
  to service_role;


-- ============================================================
-- C. Runtime assertion — verifier must return 0 rows
-- ============================================================
do $$
declare
  v_count integer;
  v_missing text;
begin
  select count(*), string_agg(missing, ', ')
    into v_count, v_missing
    from public.verify_required_schema() as v(missing);
  if v_count <> 0 then
    raise exception
      'verify_required_schema returned % rows after 20260725313000: %',
      v_count, coalesce(v_missing, '<null>')
      using errcode = 'P0001';
  end if;
end;
$$;
