-- ============================================================
-- 20260731020000_bind_temp_upload_actor.sql
-- ------------------------------------------------------------
-- KZQ-P0-003: Bind upload token to authorizing admin.
--
-- The original claim_temp_upload_for_finalize(p_token uuid) only
-- accepted the upload token — it did NOT verify that the admin
-- requesting finalize was the same admin who authorized the upload.
-- Any authenticated admin with a valid token could finalize any
-- upload, including moving the temp object to a final path and
-- registering a storage_object_ref.
--
-- This migration replaces the function with a new signature that
-- accepts p_actor_id and verifies it matches the row's actor_id:
--
--   claim_temp_upload_for_finalize(p_token uuid, p_actor_id text)
--
-- Matching rules:
--   - p_actor_id is NULL          → reject with 'invalid_actor'
--   - row.actor_id is NULL        → reject with 'actor_not_bound'
--     (the upload was not bound to an admin at authorize time)
--   - row.actor_id != p_actor_id → reject with 'actor_mismatch'
--   - otherwise                   → proceed with the claim
--
-- This is a forward-only migration. It does NOT:
--   - drop any table
--   - truncate any table
--   - delete existing rows at the migration top level
--   - alter existing columns to drop data
--   - modify existing policies
--   - modify any existing migration file
--
-- The DROP FUNCTION is necessary because PostgreSQL function
-- signatures are part of the function identity. CREATE OR REPLACE
-- with a different parameter list creates a NEW function alongside
-- the old one; it does NOT replace the old one. The old signature
-- (uuid) must be dropped explicitly before creating the new
-- signature (uuid, text).
--
-- Security model:
--   - The new function is SECURITY INVOKER, empty search_path,
--     EXECUTE granted to service_role ONLY.
--   - anon, authenticated, and PUBLIC have NO EXECUTE privilege.
--   - The old function's grants are automatically revoked by
--     DROP FUNCTION.
-- ============================================================

-- ============================================================
-- A. Drop the old claim_temp_upload_for_finalize(uuid)
-- ------------------------------------------------------------
-- The old signature accepted only the token. DROP FUNCTION
-- IF EXISTS is safe: if the old function is already gone (e.g.
-- re-applied on a fresh DB that started from this migration),
-- the statement is a no-op.
-- ============================================================
drop function if exists public.claim_temp_upload_for_finalize(p_token uuid);

-- ============================================================
-- B. Create the new claim_temp_upload_for_finalize(uuid, text)
-- ------------------------------------------------------------
-- Phase 2 RPC, step 1: atomically claim a temp_uploads row for
-- finalization. Uses SELECT FOR UPDATE SKIP LOCKED so concurrent
-- /finalize requests for the same token do not block each other.
--
-- KZQ-P0-003: Now verifies that p_actor_id matches the row's
-- actor_id, so only the admin who authorized the upload can
-- finalize it.
--
-- Valid transitions:
--   authorized → finalizing  (this RPC)
--   * → *                       (any other transition is rejected)
--
-- Rejects if:
--   - token not found
--   - status != 'authorized'
--   - expires_at <= now() (stale)
--   - p_actor_id is null (finalize must identify the actor)
--   - row.actor_id is null (upload not bound to an admin)
--   - row.actor_id != p_actor_id (wrong admin)
-- ============================================================
create or replace function public.claim_temp_upload_for_finalize(
  p_token uuid,
  p_actor_id text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.temp_uploads;
begin
  if p_token is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_token');
  end if;

  -- KZQ-P0-003: finalize must identify the actor. The route always
  -- passes guard.user.id; a null p_actor_id indicates a bug or a
  -- service-role-only call that bypassed the route boundary.
  if p_actor_id is null or p_actor_id = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_actor');
  end if;

  -- SELECT FOR UPDATE SKIP LOCKED: if another /finalize request
  -- has already locked this row, we skip it and return not_found
  -- rather than blocking.
  select * into v_row
  from public.temp_uploads
  where id = p_token
  for update skip locked;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found_or_locked');
  end if;

  -- Status check: only 'authorized' rows can be claimed.
  if v_row.status != 'authorized' then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_status',
      'status', v_row.status
    );
  end if;

  -- Expiry check: stale rows cannot be claimed.
  if v_row.expires_at <= now() then
    -- Mark as failed so the cleanup dispatcher can reap it.
    update public.temp_uploads
    set status = 'failed', failure_reason = 'expired_before_finalize'
    where id = p_token;
    return jsonb_build_object(
      'ok', false,
      'error', 'expired',
      'expires_at', to_jsonb(v_row.expires_at)
    );
  end if;

  -- KZQ-P0-003: Actor binding check.
  -- The row's actor_id is set at authorize time. If it is null,
  -- the upload was not bound to an admin — reject so that only
  -- admin-bound uploads can be finalized. If it is non-null, it
  -- must match the caller's p_actor_id.
  if v_row.actor_id is null then
    return jsonb_build_object('ok', false, 'error', 'actor_not_bound');
  end if;

  if v_row.actor_id != p_actor_id then
    return jsonb_build_object('ok', false, 'error', 'actor_mismatch');
  end if;

  -- Atomic transition: authorized → finalizing.
  update public.temp_uploads
  set status = 'finalizing'
  where id = p_token and status = 'authorized'
  returning * into v_row;

  if not found then
    -- Race: another request claimed it between our SELECT and UPDATE.
    return jsonb_build_object('ok', false, 'error', 'race_claimed');
  end if;

  return jsonb_build_object('ok', true, 'row', to_jsonb(v_row));
end;
$$;

revoke all on function public.claim_temp_upload_for_finalize(uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_temp_upload_for_finalize(uuid, text)
  to service_role;
