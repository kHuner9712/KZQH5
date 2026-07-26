-- ============================================================
-- 20260725210000_storage_cleanup_audit_saga.sql
-- ------------------------------------------------------------
-- Forward-only migration that wires the Storage Cleanup Dispatcher
-- into the Storage Audit Saga (Section 9 of the commercial delivery
-- review).
--
-- BEFORE this migration:
--   - `admin_storage_operations.action` accepted only
--     'storage.upload' | 'storage.delete'.
--   - `storage_cleanup_queue` had no link to the audit row that
--     witnessed the actual Storage .remove() call. The dispatcher
--     deleted the object and finalized the cleanup row in two
--     unrelated steps, which made it impossible to answer the
--     question "which audit row proves object X was deleted?".
--   - On reference-check error, the dispatcher marked the cleanup
--     row `success=true` (terminated), hiding the failure forever.
--
-- AFTER this migration:
--   A. `record_storage_operation_started` accepts a new action
--      `storage.cleanup_delete` so the cleanup dispatcher can record
--      a pending audit row BEFORE calling Storage .remove().
--   B. `storage_cleanup_queue` gets a nullable `storage_operation_id`
--      column + index so the dispatcher can persist the link in the
--      SAME `complete_storage_cleanup` RPC that finalizes the row.
--      This makes "audit started but cleanup completion failed"
--      observable from a single query.
--   C. `complete_storage_cleanup` gains an optional
--      `p_storage_operation_id` parameter. When supplied, the RPC
--      writes the link in the same transaction that finalizes the
--      cleanup row — no best-effort update, no orphan audit rows.
--   D. `storage_cleanup_queue` gains a `final_status` column so the
--      dispatcher can distinguish:
--        - 'deleted'            (referenced=false, Storage remove ok)
--        - 'blocked_referenced' (referenced=true, NOT deleted, terminal)
--        - 'reference_check_failed' (RPC error, retry → dead_letter)
--        - 'storage_delete_failed'  (Storage remove error, retry)
--      This replaces the prior bug where every non-delete outcome
--      was flattened into `success=true` + a free-text error_code.
--
-- All changes are additive. No existing column is dropped or
-- retyped. The migration is safe to apply on a database where the
-- cleanup dispatcher has already run.
-- ============================================================

-- ============================================================
-- A. Allow 'storage.cleanup_delete' as an audit action
-- ============================================================
-- The existing check is a plpgsql `if v_action not in (...)` clause
-- inside `record_storage_operation_started`. We replace the function
-- with a variant that also accepts 'storage.cleanup_delete'. The
-- signature is unchanged, so existing callers are unaffected.

create or replace function public.record_storage_operation_started(
  p_actor_id uuid default null,
  p_actor_role text default null,
  p_action text default null,
  p_bucket text default null,
  p_object_path text default null,
  p_mime_type text default null,
  p_size_bytes bigint default null,
  p_sha256 text default null
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_action text := coalesce(p_action, 'storage.upload');
  v_bucket text := coalesce(p_bucket, 'private-assets');
begin
  if p_object_path is null or btrim(p_object_path) = '' then
    raise exception 'object_path required' using errcode = '23502';
  end if;
  if v_action not in ('storage.upload', 'storage.delete', 'storage.cleanup_delete') then
    raise exception 'invalid action' using errcode = '22023';
  end if;
  if v_bucket not in ('public-assets', 'private-assets') then
    raise exception 'invalid bucket' using errcode = '22023';
  end if;

  insert into public.admin_storage_operations (
    actor_id, actor_role, action, bucket, object_path,
    mime_type, size_bytes, sha256, status
  ) values (
    p_actor_id, p_actor_role, v_action, v_bucket, p_object_path,
    p_mime_type, p_size_bytes, p_sha256, 'pending'
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.record_storage_operation_started(uuid, text, text, text, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.record_storage_operation_started(uuid, text, text, text, text, text, bigint, text)
  to service_role;

-- ============================================================
-- B. Add storage_operation_id + final_status to storage_cleanup_queue
-- ============================================================
-- `storage_operation_id` is nullable because:
--   - The dispatcher only creates an audit row when it intends to
--     call Storage .remove(). Rows that are completed without a
--     delete (e.g. 'blocked_referenced') have no audit row.
--   - Rows that existed before this migration have NULL, which is
--     correct — there was no audit row for them either.
-- `final_status` is nullable for backward compatibility; the
-- dispatcher sets it on every new completion. Legacy rows keep NULL.

alter table public.storage_cleanup_queue
  add column if not exists storage_operation_id uuid,
  add column if not exists final_status text;

comment on column public.storage_cleanup_queue.storage_operation_id is
  'Link to admin_storage_operations.id for the audit row that witnessed the Storage .remove() call. NULL when no delete was attempted (e.g. blocked_referenced) or for legacy rows.';

comment on column public.storage_cleanup_queue.final_status is
  'Coarse outcome set by the dispatcher: deleted | blocked_referenced | reference_check_failed | storage_delete_failed. NULL for legacy rows.';

create index if not exists idx_storage_cleanup_operation
  on public.storage_cleanup_queue(storage_operation_id)
  where storage_operation_id is not null;

create index if not exists idx_storage_cleanup_final_status
  on public.storage_cleanup_queue(final_status)
  where final_status is not null;

-- ============================================================
-- C. complete_storage_cleanup — accept optional operation link
-- ============================================================
-- The signature gains `p_storage_operation_id` and `p_final_status`.
-- Both are optional (NULL allowed) so existing callers compiled
-- against the old signature continue to work.
--
-- Semantics:
--   - `p_storage_operation_id` (optional): when supplied, persisted
--     atomically with the cleanup row finalization. Use this to link
--     the cleanup row to the audit row that recorded the Storage
--     .remove() outcome. NULL when no audit row exists (e.g.
--     blocked_referenced — no delete was attempted).
--   - `p_final_status` (optional): coarse outcome string. The RPC
--     validates it against a fixed allowlist so bad data cannot
--     poison the column.
--   - The existing `p_success` / `p_error_code` semantics are
--     preserved. `p_success=true` still terminates the row;
--     `p_success=false` still triggers retry → dead_letter.
--
-- The check for `status = 'claimed' AND lock_token = ?` is unchanged
-- — concurrent workers still cannot finalize each other's rows.

create or replace function public.complete_storage_cleanup(
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
    'storage_delete_failed'
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

revoke all on function public.complete_storage_cleanup(uuid, uuid, boolean, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.complete_storage_cleanup(uuid, uuid, boolean, text, uuid, text)
  to service_role;

-- ============================================================
-- D. Schema verification — extend verify_required_schema
-- ============================================================
-- We extend the existing verify_required_schema() RPC so the
-- release-readiness check fails fast if this migration was not
-- applied. The function is replaced in-place; existing checks
-- remain intact.
--
-- DROP FUNCTION first because the prior migration (20260725190000)
-- declared this function with `returns table(...)`. This migration
-- switches the return type to `returns jsonb` (different composite
-- type). PostgreSQL's CREATE OR REPLACE FUNCTION does not allow
-- changing the return type, so we drop and recreate (same pattern
-- as 20260725170000 / 20260725180000 / 20260725190000 / 20260725220000
-- / 20260725230000).
-- ============================================================
drop function if exists public.verify_required_schema();

create function public.verify_required_schema() returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_missing text[] := '{}'::text[];
  v_col_exists boolean;
  v_table_exists boolean;
begin
  -- Existing checks (preserved from 20260725160000).

  if not exists (
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'product_assets'
        and column_name = 'catalog_topic_id'
  ) then v_missing := array_append(v_missing, 'column:product_assets.catalog_topic_id'); end if;

  if not exists (
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'product_assets'
        and column_name = 'cover_image_url'
  ) then v_missing := array_append(v_missing, 'column:product_assets.cover_image_url'); end if;

  if not exists (
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'product_assets'
        and column_name = 'published_at'
  ) then v_missing := array_append(v_missing, 'column:product_assets.published_at'); end if;

  if not exists (
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'product_assets'
        and column_name = 'content_hash'
  ) then v_missing := array_append(v_missing, 'column:product_assets.content_hash'); end if;

  -- admin_storage_operations must exist.
  select exists (
    select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'admin_storage_operations'
  ) into v_table_exists;
  if not v_table_exists then v_missing := array_append(v_missing, 'table:admin_storage_operations'); end if;

  -- storage_cleanup_queue must exist.
  select exists (
    select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'storage_cleanup_queue'
  ) into v_table_exists;
  if not v_table_exists then v_missing := array_append(v_missing, 'table:storage_cleanup_queue'); end if;

  -- storage_object_refs must exist (20260725170000).
  select exists (
    select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'storage_object_refs'
  ) into v_table_exists;
  if not v_table_exists then v_missing := array_append(v_missing, 'table:storage_object_refs'); end if;

  -- Section 9 (this migration): storage_cleanup_queue.storage_operation_id
  select exists (
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'storage_cleanup_queue'
        and column_name = 'storage_operation_id'
  ) into v_col_exists;
  if not v_col_exists then v_missing := array_append(v_missing, 'column:storage_cleanup_queue.storage_operation_id'); end if;

  -- Section 9 (this migration): storage_cleanup_queue.final_status
  select exists (
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'storage_cleanup_queue'
        and column_name = 'final_status'
  ) into v_col_exists;
  if not v_col_exists then v_missing := array_append(v_missing, 'column:storage_cleanup_queue.final_status'); end if;

  -- Section 11 (20260725170000): product_assets publish state machine
  select exists (
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'product_assets'
        and column_name = 'publish_status'
  ) into v_col_exists;
  if not v_col_exists then v_missing := array_append(v_missing, 'column:product_assets.publish_status'); end if;

  select exists (
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'product_assets'
        and column_name = 'publish_token'
  ) into v_col_exists;
  if not v_col_exists then v_missing := array_append(v_missing, 'column:product_assets.publish_token'); end if;

  if coalesce(array_length(v_missing, 1), 0) = 0 then
    return jsonb_build_object('ok', true, 'missing', '[]'::text[]);
  end if;
  return jsonb_build_object('ok', false, 'missing', to_jsonb(v_missing));
end;
$$;

revoke all on function public.verify_required_schema()
  from public, anon, authenticated;
grant execute on function public.verify_required_schema()
  to service_role;

-- ============================================================
-- End of migration
-- ============================================================
