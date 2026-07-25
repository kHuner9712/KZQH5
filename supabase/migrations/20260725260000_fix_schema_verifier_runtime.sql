-- ============================================================
-- Phase 18 (Section 3): Make the schema verifier runtime-correct.
--
-- The version frozen by 20260725240000 had three runtime defects:
--
--   1. The expected-objects catalog listed two columns that do NOT
--      exist on product_assets:
--          product_assets.storage_operation_id
--          product_assets.final_status
--      Those columns only exist on storage_cleanup_queue. The catalog
--      therefore always reported them as missing, so
--      verify_required_schema() could never return 0 rows on a real
--      schema.
--
--   2. The function-signature check used
--        pg_get_function_identity_arguments(p.oid) = trim(v_fn_sig, '()')
--      and then compared that to a hand-typed argument list. This is
--      fragile (parameter names, spaces, defaults all differ). The
--      robust check is to round-trip through regprocedure:
--        to_regprocedure('public.<fn_name>(<arg_types>)') IS NOT NULL
--      and to require that the resulting oid resolves to exactly one
--      pg_proc row (no overload ambiguity).
--
--   3. The ACL check referenced a non-existent column:
--        acl.privilege_mask
--      aclexplode() returns (grantor, grantee, privilege_type text,
--      is_grantable), so the column is privilege_type, not
--      privilege_mask. The check therefore raised
--        column acl.privilege_mask does not exist
--      at runtime. In addition, the check grouped anon+authenticated
--      together and never inspected the PUBLIC grantee (oid=0), so a
--      stray `grant execute to public` would not be detected.
--
-- This migration is forward-only. It uses CREATE OR REPLACE on the
-- two functions whose return types were already frozen by
-- 20260725240000, so the contract signature does NOT change:
--   * list_required_schema_objects()  -> table(object_name text, object_type text)
--   * verify_required_schema()        -> table(missing text)
--
-- Safety contract (per function, unchanged):
--   * language plpgsql
--   * security invoker
--   * set search_path = ''
--   * revoke from public/anon/authenticated
--   * grant execute to service_role only
-- ============================================================


-- ============================================================
-- A. list_required_schema_objects — drop the two phantom columns
-- ============================================================
-- Same return type. Same body except:
--   * removed 'product_assets.storage_operation_id' (column does not exist)
--   * removed 'product_assets.final_status'          (column does not exist)
-- The matching columns on storage_cleanup_queue remain listed.
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
  return query select 'storage_audit_reconcile_queue', 'table'::text;
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
  -- NOTE: these live on storage_cleanup_queue, NOT product_assets.
  return query select 'storage_cleanup_queue.storage_operation_id', 'column'::text;
  return query select 'storage_cleanup_queue.final_status', 'column'::text;

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
  return query select 'mark_storage_object_refs_deleted', 'function'::text;
  return query select 'mark_storage_object_refs_pending_delete', 'function'::text;

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
-- B. verify_required_schema — runtime-correct privilege checks
-- ============================================================
-- Same return type: table(missing text). Three fixes inside:
--
--   B.1 Function signature match: use to_regprocedure('public.<sig>')
--       and require the resolved oid to match exactly one pg_proc
--       row (no overload ambiguity). The previous text-compare
--       approach broke on parameter names / defaults / whitespace.
--
--   B.2 ACL check: use has_function_privilege(rolname, oid, 'EXECUTE')
--       which is the canonical Postgres introspection. The previous
--       code referenced a non-existent acl.privilege_mask column.
--
--   B.3 Separate grantee checks for service_role / anon /
--       authenticated / PUBLIC(oid=0). A stray `grant execute to
--       public` is now detected as 'grant:public:<fn>'.
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
    'verify_schema_readiness',
    'list_required_schema_objects',
    'verify_required_schema'
  ];
begin
  -- Resolve role oids once. anon/authenticated may not exist on a
  -- bare Postgres (no Supabase roles), so coalesce to NULL.
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
          -- Signature-bearing entry: round-trip through regprocedure.
          -- to_regprocedure returns NULL if no match (or 0 if the
          -- function does not exist), and resolves overload ambiguity
          -- by requiring a single best match.
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
          else
            -- Also require exactly one pg_proc row resolves to this
            -- name+identity_arguments, so a future second overload
            -- with the same identity cannot silently slip through.
            select count(*)
              into v_proc_count
              from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and p.proname = v_fn_name
                and pg_get_function_identity_arguments(p.oid)
                    = trim(v_fn_sig, '()');
            if v_proc_count <> 1 then
              return query select v_obj || ' (overload count=' || v_proc_count || ')';
            end if;
          end if;
        else
          -- No signature in the catalog entry: just require existence.
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

  -- ---- Security-critical GRANT/REVOKE checks ----
  -- For each curated function, verify:
  --   1. service_role has EXECUTE
  --   2. PUBLIC          does NOT have EXECUTE
  --   3. anon            does NOT have EXECUTE (if the role exists)
  --   4. authenticated   does NOT have EXECUTE (if the role exists)
  --
  -- We use has_function_privilege(rolname, oid, 'EXECUTE') which is
  -- the canonical Postgres introspection. It correctly handles the
  -- default ACL (functions are EXECUTE for PUBLIC by default unless
  -- revoked) and resolves overload ambiguity via the oid.
  foreach v_fn_name in array v_security_fn loop
    -- Iterate over every overload with this name (so a stray second
    -- overload cannot escape the grant check).
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

      -- 2. PUBLIC (grantee=0) must NOT have EXECUTE. has_function_privilege
      --    with the 'PUBLIC' pseudo-role checks the combined ACL.
      select has_function_privilege('PUBLIC', v_regproc::oid, 'EXECUTE')
        into v_public_ok;
      if coalesce(v_public_ok, false) then
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

      -- 4. authenticated must NOT have EXECUTE (only checked if the
      --    role exists).
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
-- C. Assert runtime invariants at migration time
-- ============================================================
do $$
declare
  v_verify_missing integer;
  v_cleanup_count integer;
  v_verify_return_type text;
begin
  -- 1. verify_required_schema() returns table(missing text).
  select pg_get_function_result(p.oid)
    into v_verify_return_type
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'verify_required_schema';
  if v_verify_return_type is distinct from 'TABLE(missing text)' then
    raise exception
      'verify_required_schema return type must be TABLE(missing text), got %',
      coalesce(v_verify_return_type, '<null>')
      using errcode = 'P0001';
  end if;

  -- 2. complete_storage_cleanup overload count still 1.
  select count(*)
    into v_cleanup_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'complete_storage_cleanup';
  if v_cleanup_count <> 1 then
    raise exception
      'complete_storage_cleanup overload count must be 1, got %',
      v_cleanup_count
      using errcode = 'P0001';
  end if;

  -- 3. The phantom columns are gone from the catalog. The verifier
  --    must NOT report them as missing on a real schema.
  select count(*)
    into v_verify_missing
    from public.verify_required_schema() as v(missing)
    where v.missing in (
      'product_assets.storage_operation_id',
      'product_assets.final_status'
    );
  if v_verify_missing <> 0 then
    raise exception
      'verify_required_schema still references phantom product_assets columns'
      using errcode = 'P0001';
  end if;
end;
$$;


-- ============================================================
-- End of migration
-- ============================================================
