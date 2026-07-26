-- ============================================================
-- Phase 16 (Section 4 + 5): Canonicalize complete_storage_cleanup
-- signature and stabilize the verify_required_schema contract.
--
-- This migration is forward-only and additive with respect to the
-- application contract. It DOES drop and recreate two functions, but
-- only because:
--   * complete_storage_cleanup had two overlapping overloads that
--     caused "function is not unique" errors at call sites that pass
--     a 4-argument literal (the unknown-type literal could not be
--     resolved between the 4-arg and 6-arg candidates).
--   * verify_required_schema had its return type changed repeatedly
--     across prior pending migrations (table -> table with renamed
--     column -> jsonb -> table). We now freeze the contract as
--     `returns table(missing text)` and move the hardcoded "expected
--     objects" list into a separate list_required_schema_objects()
--     function so the two responsibilities are decoupled.
--
-- Safety contract (per function):
--   * language plpgsql
--   * security invoker   -> runs with caller privileges (service_role)
--   * set search_path = '' -> all tables qualified as public.<table>
--   * revoke from public/anon/authenticated
--   * grant execute to service_role only
--
-- Forward-only: this migration does not alter existing table data.
-- This migration is NOT executed in this commit.
-- ============================================================


-- ============================================================
-- A. Canonicalize complete_storage_cleanup to a single 6-arg signature
-- ============================================================
-- Prior state (caused CI failure):
--   * 20260725110000 created complete_storage_cleanup(uuid, uuid,
--     boolean, text default null) -> 4-arg overload.
--   * 20260725210000 created complete_storage_cleanup(uuid, uuid,
--     boolean, text default null, uuid default null, text default
--     null) -> 6-arg overload with defaults.
--
-- Both overloads accepted a 4-argument call, but PostgreSQL could not
-- pick a best candidate when the 4th argument was an unknown-type
-- literal (e.g. 'STORAGE_DELETE_FAILED'). The fix is to keep ONLY the
-- 6-arg signature (which is a superset: the last two parameters have
-- defaults, so existing 4-arg callers continue to work).
--
-- Behavioral contract preserved:
--   * p_success=true  -> status='completed', returns 'completed'.
--   * p_success=false -> retry until attempts >= max_attempts, then
--     status='dead_letter', returns 'dead_letter' or 'retry'.
--   * Wrong lock token / not claimed -> returns 'NOT_FOUND_OR_TOKEN_MISMATCH'.
--   * Invalid params (null id/token, or invalid final_status) ->
--     returns 'INVALID_PARAMS'.
--   * p_storage_operation_id links the cleanup row to the audit row
--     that recorded the Storage .remove() outcome.
--   * p_final_status is validated against a fixed allowlist:
--       'deleted', 'blocked_referenced', 'reference_check_failed',
--       'storage_delete_failed'.
--   * retry path, dead-letter path, operation link, and final_status
--     semantics are all preserved.
-- ============================================================
drop function if exists public.complete_storage_cleanup(
  uuid, uuid, boolean, text
);
drop function if exists public.complete_storage_cleanup(
  uuid, uuid, boolean, text, uuid, text
);

create function public.complete_storage_cleanup(
  p_cleanup_id uuid,
  p_lock_token uuid,
  p_success boolean,
  p_error_code text default null,
  p_storage_operation_id uuid default null,
  p_final_status text default null
) returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_attempts integer;
  v_max_attempts integer;
  v_final_status text := p_final_status;
begin
  if p_cleanup_id is null or p_lock_token is null then
    return 'INVALID_PARAMS';
  end if;

  -- Validate final_status against a fixed allowlist. NULL is allowed
  -- for backward compatibility with callers that pre-date this column.
  if v_final_status is not null and v_final_status not in (
    'deleted',
    'blocked_referenced',
    'reference_check_failed',
    'storage_delete_failed',
    'audit_start_failed'
  ) then
    return 'INVALID_PARAMS';
  end if;

  select attempts, max_attempts into v_attempts, v_max_attempts
    from public.storage_cleanup_queue
    where id = p_cleanup_id
      and status = 'claimed'
      and lock_token = p_lock_token
    for update;

  if not found then
    return 'NOT_FOUND_OR_TOKEN_MISMATCH';
  end if;

  if p_success then
    update public.storage_cleanup_queue
      set status = 'completed',
          completed_at = now(),
          lock_token = null,
          locked_at = null,
          last_error_code = null,
          storage_operation_id = coalesce(p_storage_operation_id, storage_operation_id),
          final_status = coalesce(v_final_status, final_status),
          updated_at = now()
      where id = p_cleanup_id;
    return 'completed';
  end if;

  v_attempts := v_attempts + 1;
  if v_attempts >= v_max_attempts then
    update public.storage_cleanup_queue
      set status = 'dead_letter',
          attempts = v_attempts,
          last_error_code = left(coalesce(p_error_code, 'unknown'), 80),
          lock_token = null,
          locked_at = null,
          storage_operation_id = coalesce(p_storage_operation_id, storage_operation_id),
          final_status = coalesce(v_final_status, final_status),
          updated_at = now()
      where id = p_cleanup_id;
    return 'dead_letter';
  else
    update public.storage_cleanup_queue
      set status = 'retry',
          attempts = v_attempts,
          last_error_code = left(coalesce(p_error_code, 'unknown'), 80),
          next_retry_at = now() + least(
            make_interval(secs => 60) * power(2, v_attempts - 1),
            interval '30 minutes'
          ),
          lock_token = null,
          locked_at = null,
          storage_operation_id = coalesce(p_storage_operation_id, storage_operation_id),
          final_status = coalesce(v_final_status, final_status),
          updated_at = now()
      where id = p_cleanup_id;
    return 'retry';
  end if;
end;
$$;

revoke all on function public.complete_storage_cleanup(
  uuid, uuid, boolean, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.complete_storage_cleanup(
  uuid, uuid, boolean, text, uuid, text
) to service_role;

-- Assert only one complete_storage_cleanup overload exists.
-- This block runs at migration time and will abort the migration if
-- some future edit re-introduces a second overload.
do $$
declare
  v_count integer;
begin
  select count(*)
    into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'complete_storage_cleanup';
  if v_count <> 1 then
    raise exception
      'expected exactly 1 complete_storage_cleanup overload, found %',
      v_count
      using errcode = 'P0001';
  end if;
end;
$$;


-- ============================================================
-- B. Stabilize verify_required_schema contract
-- ============================================================
-- Prior state (unstable contract):
--   * 20260725160000: returns jsonb
--   * 20260725170000: returns table(object_name text, object_type text)
--   * 20260725180000: returns table(object_name text, object_type text)
--   * 20260725190000: returns table(object_name text, object_kind text)
--   * 20260725210000: returns jsonb
--   * 20260725220000: returns table(object_name text, object_type text)
--   * 20260725230000: returns table(object_name text, object_type text)
--
-- Every change required DROP FUNCTION + CREATE FUNCTION because
-- PostgreSQL does not allow CREATE OR REPLACE to change the return
-- type. This churn is a contract hazard: callers cannot rely on a
-- stable shape.
--
-- This migration freezes TWO separate responsibilities:
--
--   1. list_required_schema_objects()
--      returns table(object_name text, object_type text)
--      -> Returns the hardcoded "expected objects" list. This is a
--         documentation catalog, NOT a verification result. Callers
--         that want to enumerate expectations use this.
--
--   2. verify_required_schema()
--      returns table(missing text)
--      -> Returns the set of MISSING object identifiers. Empty result
--         means the schema is complete. This is a true verification:
--         it checks pg_class / information_schema.columns / pg_proc /
--         pg_default ACL for each expected object.
--
-- From this migration forward, the return types of BOTH functions are
-- FROZEN. Future migrations must not change them. To add a new
-- expected object, update list_required_schema_objects() body only
-- (CREATE OR REPLACE with the SAME return type is allowed).
--
-- Note: verify_schema_readiness() (defined by 20260724160000) is a
-- SEPARATE function used by the release-readiness script. Its contract
-- is unchanged and remains stable.
-- ============================================================
drop function if exists public.verify_required_schema();
drop function if exists public.list_required_schema_objects();


-- ============================================================
-- B.1 list_required_schema_objects — the expected-objects catalog
-- ============================================================
-- Returns one row per expected schema object. object_type is one of:
--   'table' | 'column' | 'function' | 'index' | 'constraint'
--
-- For functions, object_name encodes the full signature, e.g.
--   'complete_storage_cleanup(uuid, uuid, boolean, text, uuid, text)'
-- so callers can detect signature drift.
--
-- This list is the single source of truth for "what the schema should
-- contain". Adding a new expected object here makes it visible to
-- verify_required_schema() automatically.
-- ============================================================
create function public.list_required_schema_objects()
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
  return query select 'product_assets.storage_operation_id', 'column'::text;
  return query select 'product_assets.final_status', 'column'::text;

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
-- B.2 verify_required_schema — the true verification
-- ============================================================
-- Returns the set of MISSING object identifiers from the expected
-- catalog. Empty result means the schema is complete.
--
-- Verification checks (per expected object):
--   * table    -> exists in pg_class with relkind='r'
--   * column   -> table exists AND column exists in
--                 information_schema.columns
--   * function -> exists in pg_proc. If object_name contains a
--                 signature, the exact signature is matched via
--                 pg_get_function_identity_arguments.
--   * index    -> exists in pg_indexes
--   * constraint -> exists in pg_constraint
--
-- Additionally, for a curated subset of security-critical functions,
-- this RPC verifies that:
--   * execute is granted to service_role
--   * execute is NOT granted to anon or authenticated
--
-- This is NOT a hardcoded "list of expected objects returned as
-- present". It is a real check that returns only the MISSING ones.
-- ============================================================
create function public.verify_required_schema()
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
  v_sig_match boolean;
  v_has_anon_grant boolean;
  v_grantee_ok boolean;
  v_service_role_ok boolean;
  -- Curated list of (function_name, exact_signature) pairs that must
  -- be service_role-only. We check GRANT/REVOKE on these.
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
  -- Iterate over the expected-objects catalog.
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
        -- v_obj is "<table>.<column>"
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
        -- v_obj may be "fn_name" or "fn_name(arg1, arg2, ...)".
        v_paren_pos := position('(' in v_obj);
        if v_paren_pos > 0 then
          v_fn_name := left(v_obj, v_paren_pos - 1);
          v_fn_sig := substring(v_obj from v_paren_pos);
          -- Match by identity arguments.
          select exists (
            select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and p.proname = v_fn_name
                and pg_get_function_identity_arguments(p.oid) = trim(v_fn_sig, '()')
          ) into v_sig_match;
          if not v_sig_match then
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
        -- Unknown object_type — report as missing so the catalog
        -- stays honest about what it can verify.
        return query select v_obj;
    end case;
  end loop;

  -- ---- Security-critical GRANT/REVOKE checks ----
  -- For each function in v_security_fn, verify:
  --   1. service_role has EXECUTE
  --   2. anon and authenticated do NOT have EXECUTE
  foreach v_fn_name in array v_security_fn loop
    -- service_role grant check
    select exists (
      select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        left join lateral (
          select (aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))).*
        ) as acl on true
        where n.nspname = 'public'
          and p.proname = v_fn_name
          and acl.grantee = (select oid from pg_roles where rolname = 'service_role')
          and (acl.privilege_mask & 16) <> 0  -- ACL_EXECUTE
    ) into v_service_role_ok;

    if not v_service_role_ok then
      return query select 'grant:service_role:' || v_fn_name;
    end if;

    -- anon/authenticated grant check (must be ABSENT)
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
          and (acl.privilege_mask & 16) <> 0  -- ACL_EXECUTE
    ) into v_has_anon_grant;

    if v_has_anon_grant then
      return query select 'grant:anon_or_authenticated:' || v_fn_name;
    end if;
  end loop;

  return;
end;
$$;

revoke all on function public.verify_required_schema()
  from public, anon, authenticated;
grant execute on function public.verify_required_schema()
  to service_role;


-- ============================================================
-- C. Assert contract invariants at migration time
-- ============================================================
-- These assertions abort the migration if the contract is violated,
-- making it impossible to ship a half-applied state.
do $$
declare
  v_cleanup_count integer;
  v_verify_return_type text;
  v_list_return_type text;
begin
  -- 1. Exactly one complete_storage_cleanup overload.
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

  -- 2. verify_required_schema returns table(missing text).
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

  -- 3. list_required_schema_objects returns table(object_name text, object_type text).
  select pg_get_function_result(p.oid)
    into v_list_return_type
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'list_required_schema_objects';
  if v_list_return_type is distinct from 'TABLE(object_name text, object_type text)' then
    raise exception
      'list_required_schema_objects return type must be TABLE(object_name text, object_type text), got %',
      coalesce(v_list_return_type, '<null>')
      using errcode = 'P0001';
  end if;
end;
$$;


-- ============================================================
-- End of migration
-- ============================================================
