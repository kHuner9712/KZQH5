-- ============================================================
-- Phase 18 (Section 5): Fix schema verifier OID contract.
--
-- The version frozen by 20260725260000 had two residual defects
-- that caused the migration itself to fail on PostgreSQL 16:
--
--   1. PUBLIC privilege check used:
--        select has_function_privilege('PUBLIC', v_regproc::oid, 'EXECUTE')
--      PostgreSQL 16 looks up 'PUBLIC' in pg_roles and raises:
--        ERROR: role "PUBLIC" does not exist
--      because PUBLIC is a pseudo-role (oid=0) not present in
--      pg_roles. The migration's own runtime assertion (Section C
--      of 20260725260000) therefore failed at:
--        select count(*) from public.verify_required_schema()
--      blocking the entire migration from completing.
--
--   2. The signature check mixed two concerns:
--        a) to_regprocedure('public.<sig>')  -> OID existence
--        b) pg_get_function_identity_arguments(p.oid) = trim(v_fn_sig, '()')
--           -> text equality on the argument list
--      (b) is fragile (parameter names, defaults, whitespace) and
--      conflates "exact signature exists" with "the name has only
--      one overload". They must be separate checks.
--
-- This migration is forward-only. The return type of
-- verify_required_schema() is unchanged: table(missing text).
--
-- New contract:
--   * Function existence  -> to_regprocedure('public.<sig>') IS NOT NULL
--   * Overload gate        -> separate functions_requiring_single_overload
--                             array, counted by pronamespace + proname
--   * service_role grant   -> has_function_privilege(rolname, oid, 'EXECUTE')
--   * PUBLIC grant         -> aclexplode(proacl) with grantee=0 and
--                             privilege_type='X' (EXECUTE)
--   * anon/authenticated   -> has_function_privilege(rolname, oid, 'EXECUTE')
--                             only if the role exists
-- ============================================================


-- ============================================================
-- A. verify_required_schema — OID-contract rewrite
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
  -- Functions that must have EXACTLY one overload. A second overload
  -- is a contract violation even if the cataloged signature still
  -- resolves, because call sites depend on unambiguous dispatch.
  v_single_overload_fn text[] := array[
    'complete_storage_cleanup',
    'register_storage_object_ref',
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
    'verify_required_schema',
    'list_required_schema_objects'
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
          -- Signature-bearing entry: resolve via to_regprocedure ONLY.
          -- No text comparison of argument lists. OID is NULL -> missing.
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

  -- ---- Overload-count gate for curated functions ----
  -- Functions in v_single_overload_fn must have exactly one pg_proc
  -- row in public. A second overload is a contract violation even
  -- if the cataloged signature still resolves, because call sites
  -- depend on unambiguous dispatch.
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
  -- For each curated function (across ALL overloads, so a stray
  -- second overload cannot escape the grant check):
  --   1. service_role has EXECUTE
  --   2. PUBLIC (grantee oid=0) does NOT have EXECUTE
  --   3. anon does NOT have EXECUTE (if the role exists)
  --   4. authenticated does NOT have EXECUTE (if the role exists)
  --
  -- PUBLIC is checked via aclexplode(proacl) because
  -- has_function_privilege('PUBLIC', oid, 'EXECUTE') raises
  -- "role PUBLIC does not exist" on PostgreSQL 16 — PUBLIC is a
  -- pseudo-role (oid=0) not present in pg_roles.
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
      --    Use aclexplode(proacl) — the canonical ACL introspection.
      --    privilege_type 'X' = EXECUTE (see pg_builtin_acl).
      v_public_ok := false;
      select p.proacl into v_proacl
        from pg_proc p
        where p.oid = v_regproc::oid;
      if v_proacl is null then
        -- proacl is NULL -> default ACL -> EXECUTE granted to PUBLIC.
        -- Functions are EXECUTE-for-PUBLIC by default unless revoked.
        v_public_ok := true;
      else
        for v_acl_row in select * from aclexplode(v_proacl) loop
          if v_acl_row.grantee = 0 and v_acl_row.privilege_type = 'X' then
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
-- B. Runtime assertion — the migration must complete on PG16
-- ============================================================
-- This is the exact call that failed before. It must now return 0
-- rows on a healthy schema. If it raises 'role PUBLIC does not
-- exist', the migration itself fails and CI blocks — which is the
-- correct signal that the verifier is broken.
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
      'verify_required_schema returned % rows after 20260725262000: %',
      v_count, coalesce(v_missing, '<null>')
      using errcode = 'P0001';
  end if;
end;
$$;


-- ============================================================
-- End of migration
-- ============================================================
