-- ============================================================
-- 20260725180000_storage_audit_reconcile_claim.sql
-- ------------------------------------------------------------
-- Forward-only migration that introduces DB-level claim/reconcile
-- RPCs for `admin_storage_operations` so that multiple workers can
-- safely process long-pending audit rows in parallel.
--
-- Section 10 of the commercial delivery review requires:
--   - Multi-level path existence check uses the FULL parent
--     directory (not just the first segment).
--   - Exact object path validation (not fuzzy search).
--   - Multi-Worker concurrency must not process the same pending
--     operation twice → requires claim token or DB row lock.
--   - On completion, the token must be verified.
--   - Long-term failures must enter a dead-letter/review state.
--   - `processed` count must NOT include rows skipped due to lock
--     conflict or query failure.
--
-- This migration:
--   A. Adds reconcile_lock_token + reconcile_locked_at columns to
--      admin_storage_operations (NULL for non-pending rows and for
--      pending rows not yet claimed by a reconciler).
--   B. Adds a partial index on pending rows eligible for reconcile
--      (created_at older than the threshold is enforced at claim
--      time, not in the index, to keep the index simple).
--   C. claim_storage_audit_reconcile(p_min_age_seconds, p_limit,
--      p_stale_timeout_seconds) → atomically marks N pending rows
--      as reconcile-claimed using FOR UPDATE SKIP LOCKED, generates
--      a per-row lock_token, and returns the rows. Re-claims rows
--      whose reconcile_locked_at is older than the stale timeout.
--   D. complete_storage_audit_reconcile(p_operation_id,
--      p_lock_token, p_success, p_error_code) → verifies token,
--      then calls complete_storage_operation (existing RPC) to
--      mark the audit row completed/failed. Returns the final
--      status so the worker can count dead_letter-equivalent.
--   E. Adds a verify_required_schema update for the new columns
--      and RPCs.
--
-- Forward-only: this migration only ADDS columns and functions; it
-- does not drop or modify existing table data.
-- ============================================================

-- ============================================================
-- A. Add reconcile lock columns to admin_storage_operations
-- ============================================================
alter table public.admin_storage_operations
  add column if not exists reconcile_lock_token uuid,
  add column if not exists reconcile_locked_at timestamptz;

comment on column public.admin_storage_operations.reconcile_lock_token is
  'Per-row lock token held by a reconciler while checking object existence. NULL when not actively reconciled.';
comment on column public.admin_storage_operations.reconcile_locked_at is
  'When the row was claimed by a reconciler. Used for stale-lock recovery. NULL when not actively reconciled.';

-- Partial index for rows that are pending AND have been reconcile-claimed
-- (used by stale recovery to find rows to re-claim). Pending rows that
-- have NOT been claimed yet are matched via the existing
-- idx_admin_storage_ops_status index.
create index if not exists idx_admin_storage_ops_reconcile_locked
  on public.admin_storage_operations(reconcile_locked_at)
  where status = 'pending' and reconcile_locked_at is not null;

-- ============================================================
-- B. claim_storage_audit_reconcile RPC
-- ============================================================
-- Atomically claims a batch of pending admin_storage_operations rows
-- whose created_at is older than p_min_age_seconds. Uses FOR UPDATE
-- SKIP LOCKED so concurrent workers do not collide. Re-claims rows
-- whose reconcile_locked_at is older than p_stale_timeout_seconds
-- (a worker that crashed mid-reconcile does not block the row).
--
-- Returns: id, action, bucket, object_path, lock_token for each
-- claimed row. The lock_token must be passed back to
-- complete_storage_audit_reconcile to finalize the row.
create or replace function public.claim_storage_audit_reconcile(
  p_min_age_seconds integer default 300,
  p_limit integer default 50,
  p_stale_timeout_seconds integer default 300
) returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_safe_min_age integer := greatest(coalesce(p_min_age_seconds, 300), 60);
  v_safe_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_safe_timeout integer := greatest(coalesce(p_stale_timeout_seconds, 300), 60);
  v_cutoff timestamptz := now() - make_interval(secs => v_safe_min_age);
  v_stale_cutoff timestamptz := now() - make_interval(secs => v_safe_timeout);
  v_rows jsonb;
begin
  with picked as (
    select id
      from public.admin_storage_operations
      where status = 'pending'
        and created_at < v_cutoff
        and (
          reconcile_locked_at is null
          or reconcile_locked_at < v_stale_cutoff
        )
      order by created_at
      limit v_safe_limit
      for update skip locked
  ),
  marked as (
    update public.admin_storage_operations
      set reconcile_lock_token = gen_random_uuid(),
          reconcile_locked_at = now()
      where id in (select id from picked)
      returning id, action, bucket, object_path, reconcile_lock_token
  )
  select jsonb_agg(to_jsonb(marked)) into v_rows
    from marked;

  return coalesce(v_rows, '[]'::jsonb);
end;
$$;

revoke all on function public.claim_storage_audit_reconcile(integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_storage_audit_reconcile(integer, integer, integer)
  to service_role;

-- ============================================================
-- C. complete_storage_audit_reconcile RPC
-- ============================================================
-- Verifies the lock_token AND that the row is still pending (a
-- concurrent worker that already completed it is rejected), then
-- calls the existing complete_storage_operation RPC to mark the
-- audit row completed/failed. Clears reconcile_lock_token and
-- reconcile_locked_at.
--
-- Returns the final status string:
--   'completed'      — audit marked as completed
--   'failed'         — audit marked as failed
--   'NOT_FOUND_OR_TOKEN_MISMATCH' — row was already finalized or
--                                   the token did not match
--   'INVALID_PARAMS' — null operation_id or lock_token
create or replace function public.complete_storage_audit_reconcile(
  p_operation_id uuid,
  p_lock_token uuid,
  p_success boolean,
  p_error_code text default null
) returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_exists boolean;
  v_ok boolean;
begin
  if p_operation_id is null or p_lock_token is null then
    return 'INVALID_PARAMS';
  end if;

  -- Verify the row exists, is still pending, and the lock_token matches.
  -- FOR UPDATE so concurrent completers serialize on this row.
  select true into v_exists
    from public.admin_storage_operations
    where id = p_operation_id
      and status = 'pending'
      and reconcile_lock_token = p_lock_token
    for update;

  if not v_exists then
    return 'NOT_FOUND_OR_TOKEN_MISMATCH';
  end if;

  -- Delegate to the existing complete_storage_operation RPC for the
  -- actual status transition (it sets status, error_code, completed_at).
  v_ok := public.complete_storage_operation(
    p_operation_id := p_operation_id,
    p_success := p_success,
    p_error_code := p_error_code
  );

  -- Always clear the reconcile lock regardless of complete outcome —
  -- the row is no longer pending so the lock is moot.
  update public.admin_storage_operations
    set reconcile_lock_token = null,
        reconcile_locked_at = null
    where id = p_operation_id;

  if not v_ok then
    -- The complete_storage_operation RPC returned false (no row was
    -- updated). This should not happen since we verified pending above,
    -- but defensively treat it as a mismatch.
    return 'NOT_FOUND_OR_TOKEN_MISMATCH';
  end if;

  if p_success then
    return 'completed';
  else
    return 'failed';
  end if;
end;
$$;

revoke all on function public.complete_storage_audit_reconcile(uuid, uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.complete_storage_audit_reconcile(uuid, uuid, boolean, text)
  to service_role;

-- ============================================================
-- D. verify_required_schema update (add new columns + RPCs)
-- ============================================================
-- Replace verify_required_schema to include the new columns and RPCs.
-- The function is replaced (not altered) to keep the migration
-- forward-only and idempotent.
drop function if exists public.verify_required_schema();

create function public.verify_required_schema()
returns table(missing text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_missing text[];
  v_fn_exists boolean;
  v_col_exists boolean;
  v_tbl_exists boolean;
begin
  v_missing := array[]::text[];

  -- storage_object_refs table
  select exists(
    select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'storage_object_refs'
  ) into v_tbl_exists;
  if not v_tbl_exists then
    v_missing := array_append(v_missing, 'table:storage_object_refs');
  end if;

  -- product_assets new columns
  select exists(
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'product_assets'
        and column_name = 'source_bucket'
  ) into v_col_exists;
  if not v_col_exists then v_missing := array_append(v_missing, 'column:product_assets.source_bucket'); end if;

  select exists(
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'product_assets'
        and column_name = 'publish_status'
  ) into v_col_exists;
  if not v_col_exists then v_missing := array_append(v_missing, 'column:product_assets.publish_status'); end if;

  -- certificates new columns
  select exists(
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'certificates'
        and column_name = 'source_bucket'
  ) into v_col_exists;
  if not v_col_exists then v_missing := array_append(v_missing, 'column:certificates.source_bucket'); end if;

  select exists(
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'certificates'
        and column_name = 'publish_status'
  ) into v_col_exists;
  if not v_col_exists then v_missing := array_append(v_missing, 'column:certificates.publish_status'); end if;

  -- admin_storage_operations reconcile columns
  select exists(
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'admin_storage_operations'
        and column_name = 'reconcile_lock_token'
  ) into v_col_exists;
  if not v_col_exists then v_missing := array_append(v_missing, 'column:admin_storage_operations.reconcile_lock_token'); end if;

  select exists(
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'admin_storage_operations'
        and column_name = 'reconcile_locked_at'
  ) into v_col_exists;
  if not v_col_exists then v_missing := array_append(v_missing, 'column:admin_storage_operations.reconcile_locked_at'); end if;

  -- claim_catalog_asset_publish RPC
  select exists(
    select 1 from information_schema.routines
      where routine_schema = 'public'
        and routine_name = 'claim_catalog_asset_publish'
  ) into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:claim_catalog_asset_publish'); end if;

  -- finalize_catalog_asset_publish RPC
  select exists(
    select 1 from information_schema.routines
      where routine_schema = 'public'
        and routine_name = 'finalize_catalog_asset_publish'
  ) into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:finalize_catalog_asset_publish'); end if;

  -- recover_stale_catalog_publish RPC
  select exists(
    select 1 from information_schema.routines
      where routine_schema = 'public'
        and routine_name = 'recover_stale_catalog_publish'
  ) into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:recover_stale_catalog_publish'); end if;

  -- extract_managed_storage_path_strict RPC
  select exists(
    select 1 from information_schema.routines
      where routine_schema = 'public'
        and routine_name = 'extract_managed_storage_path_strict'
  ) into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:extract_managed_storage_path_strict'); end if;

  -- claim_storage_audit_reconcile RPC
  select exists(
    select 1 from information_schema.routines
      where routine_schema = 'public'
        and routine_name = 'claim_storage_audit_reconcile'
  ) into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:claim_storage_audit_reconcile'); end if;

  -- complete_storage_audit_reconcile RPC
  select exists(
    select 1 from information_schema.routines
      where routine_schema = 'public'
        and routine_name = 'complete_storage_audit_reconcile'
  ) into v_fn_exists;
  if not v_fn_exists then v_missing := array_append(v_missing, 'function:complete_storage_audit_reconcile'); end if;

  if array_length(v_missing, 1) is null then
    return query select ''::text where false;
  else
    return query select unnest(v_missing);
  end if;
end;
$$;

revoke all on function public.verify_required_schema()
  from public, anon, authenticated;
grant execute on function public.verify_required_schema()
  to service_role;
