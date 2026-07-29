-- ============================================================
-- 20260729020000_temp_uploads_two_phase_upload.sql
-- ------------------------------------------------------------
-- Phase 4: Two-stage large file upload — temp_uploads registry.
--
-- The single-phase upload route (POST /api/admin/storage/upload)
-- is constrained by the EdgeOne Cloud Functions 6 MB request body
-- platform limit. This migration introduces the database layer for
-- the two-phase protocol documented in
-- docs/TWO_PHASE_UPLOAD_DESIGN.md:
--
--   Phase 1 (authorize): client requests an upload authorization;
--     server inserts a temp_uploads row with status='authorized'
--     and returns a short-TTL signed upload URL pointing to
--     private-assets/temp/{token}/{filename}.
--   Phase 2 (finalize): client requests finalize; server claims the
--     row (FOR UPDATE SKIP LOCKED), verifies the object via Storage
--     HEAD + range-download of Magic Bytes, then moves the object
--     to its final path and registers a storage_object_ref.
--
-- This migration is forward-only. It does NOT:
--   - drop any table
--   - truncate any table
--   - delete existing rows at the migration top level
--   - alter existing columns to drop data
--   - modify existing policies
--   - modify any existing migration file
--
-- Security model:
--   - temp_uploads is RLS-enabled with NO policies for anon /
--     authenticated / public. Only service_role bypasses RLS.
--   - All four lifecycle RPCs are SECURITY INVOKER, empty
--     search_path, EXECUTE granted to service_role ONLY.
--   - anon, authenticated, and PUBLIC have NO EXECUTE privilege.
-- ============================================================

-- ============================================================
-- A. temp_uploads table
-- ============================================================
-- Tracks the lifecycle of a two-phase upload from authorization
-- through finalization. Rows are short-lived: expired rows are
-- reaped by the temp_uploads cleanup dispatcher (future migration
-- or by extending storage_cleanup_queue).
create table if not exists public.temp_uploads (
  id uuid primary key default gen_random_uuid(),
  -- The upload token is the PRIMARY client-facing identifier.
  -- It is the UUID used to construct the temp object path and
  -- is passed back to /finalize. We use the row id directly so
  -- that there is exactly one token per row.
  purpose text not null,
  bucket text not null default 'private-assets'
    check (bucket in ('public-assets', 'private-assets')),
  -- The temp object path under the bucket. Format:
  --   temp/{token}/{filename}
  -- The {token} segment equals the row id (UUID) so the path is
  -- derivable without an extra column.
  object_path text not null,
  declared_mime_type text not null,
  declared_size bigint not null check (declared_size >= 0),
  declared_filename text not null,
  -- The FINAL bucket/path the object will be moved to on finalize.
  -- Resolved at authorize time from the purpose config so that
  -- finalize does not need to re-derive it.
  final_bucket text not null
    check (final_bucket in ('public-assets', 'private-assets')),
  final_category text not null,
  -- Actor provenance for audit. actor_id may be null for service-
  -- role-only flows; actor_role is the RBAC role at authorize time.
  actor_id text,
  actor_role text,
  -- Lifecycle status machine:
  --   authorized  — row created, signed URL issued, awaiting
  --                  client direct PUT to Storage
  --   finalizing  — claimed by /finalize, object verification
  --                  in progress (atomic transition via
  --                  claim_temp_upload_for_finalize)
  --   finalized   — object moved to final path, storage_object_ref
  --                  inserted, audit row written
  --   failed      — HEAD / range-download / move failed; object
  --                  left in temp for cleanup dispatcher
  --   rejected    — Magic Bytes mismatch or size mismatch; object
  --                  scheduled for cleanup
  status text not null default 'authorized'
    check (status in ('authorized', 'finalizing', 'finalized', 'failed', 'rejected')),
  -- The signed upload URL expires 5 minutes after creation. Rows
  -- older than expires_at with status='authorized' are stale and
  -- are reaped by the cleanup dispatcher.
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  -- Finalization bookkeeping.
  finalized_object_path text,
  finalized_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexes for cleanup dispatcher queries.
create index if not exists idx_temp_uploads_expires_at
  on public.temp_uploads (expires_at);
create index if not exists idx_temp_uploads_status
  on public.temp_uploads (status);
-- Partial index for stale-claim recovery: rows stuck in
-- 'finalizing' past 2x the TTL are candidates for recovery.
create index if not exists idx_temp_uploads_stale_finalizing
  on public.temp_uploads (updated_at)
  where status = 'finalizing';

-- ============================================================
-- B. Row Level Security
-- ============================================================
-- temp_uploads is an admin-only registry. No policies for
-- anon / authenticated / public. service_role bypasses RLS.
-- Application-side RBAC (requireAdminWrite) authorizes admins.
alter table public.temp_uploads enable row level security;

-- Drop any legacy policies (idempotent — should not exist yet).
drop policy if exists "temp_uploads_public_read" on public.temp_uploads;
drop policy if exists "temp_uploads_admin_all" on public.temp_uploads;
-- No policies = deny for anon/authenticated; service_role bypasses.

revoke all on public.temp_uploads from public, anon, authenticated;
grant select on public.temp_uploads to service_role;
grant insert, update, delete on public.temp_uploads to service_role;

-- updated_at maintenance trigger.
drop trigger if exists trg_temp_uploads_updated_at on public.temp_uploads;
create trigger trg_temp_uploads_updated_at
  before update on public.temp_uploads
  for each row execute function public.handle_updated_at();

-- ============================================================
-- C. authorize_temp_upload
-- ------------------------------------------------------------
-- Phase 1 RPC: validate purpose + MIME + size, insert a row with
-- status='authorized', and return the row as JSONB.
--
-- The caller (service_role) is responsible for:
--   1. Calling this RPC to create the row.
--   2. Generating the signed upload URL via Supabase Storage
--      createSignedUploadUrl(object_path).
--   3. Returning the signed URL + token to the client.
--
-- The RPC does NOT generate the signed URL — that requires a
-- Storage API call which belongs in the application layer.
-- ============================================================
create or replace function public.authorize_temp_upload(
  p_purpose text,
  p_filename text,
  p_mime_type text,
  p_size bigint,
  p_final_bucket text,
  p_final_category text,
  p_actor_id text default null,
  p_actor_role text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.temp_uploads;
  v_token uuid := gen_random_uuid();
  v_object_path text;
begin
  -- Basic input validation. The application layer is expected to
  -- have already validated purpose against STORAGE_PURPOSES and
  -- MIME against the purpose's allowedMimeTypes. These checks are
  -- defense-in-depth.
  if p_purpose is null or p_purpose = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_purpose');
  end if;
  if p_filename is null or p_filename = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_filename');
  end if;
  if p_mime_type is null or p_mime_type = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_mime_type');
  end if;
  if p_size is null or p_size <= 0 or p_size > 52428800 then
    -- Hard cap at 50 MB regardless of purpose (defense-in-depth;
    -- the application layer enforces per-purpose limits).
    return jsonb_build_object('ok', false, 'error', 'invalid_size');
  end if;
  if p_final_bucket not in ('public-assets', 'private-assets') then
    return jsonb_build_object('ok', false, 'error', 'invalid_final_bucket');
  end if;
  if p_final_category is null or p_final_category = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_final_category');
  end if;

  -- Construct the temp object path: temp/{token}/{filename}
  -- The token segment equals the row id so the path is derivable
  -- from the row without an extra column.
  v_object_path := 'temp/' || v_token::text || '/' || p_filename;

  insert into public.temp_uploads (
    id, purpose, bucket, object_path,
    declared_mime_type, declared_size, declared_filename,
    final_bucket, final_category,
    actor_id, actor_role,
    status, expires_at
  ) values (
    v_token, p_purpose, 'private-assets', v_object_path,
    p_mime_type, p_size, p_filename,
    p_final_bucket, p_final_category,
    p_actor_id, p_actor_role,
    'authorized', now() + interval '5 minutes'
  )
  returning * into v_row;

  return jsonb_build_object('ok', true, 'row', to_jsonb(v_row));
end;
$$;

revoke all on function public.authorize_temp_upload(text, text, text, bigint, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.authorize_temp_upload(text, text, text, bigint, text, text, text, text)
  to service_role;

-- ============================================================
-- D. claim_temp_upload_for_finalize
-- ------------------------------------------------------------
-- Phase 2 RPC, step 1: atomically claim a temp_uploads row for
-- finalization. Uses SELECT FOR UPDATE SKIP LOCKED so concurrent
-- /finalize requests for the same token do not block each other.
--
-- Valid transitions:
--   authorized → finalizing  (this RPC)
--   * → *                       (any other transition is rejected)
--
-- Rejects if:
--   - token not found
--   - status != 'authorized'
--   - expires_at <= now() (stale)
-- ============================================================
create or replace function public.claim_temp_upload_for_finalize(
  p_token uuid
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

revoke all on function public.claim_temp_upload_for_finalize(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_temp_upload_for_finalize(uuid)
  to service_role;

-- ============================================================
-- E. complete_temp_upload_finalize
-- ------------------------------------------------------------
-- Phase 2 RPC, step 2: mark the temp_uploads row as finalized and
-- record the final object path. This RPC is called AFTER the
-- application layer has:
--   1. Verified the object via Storage HEAD (Content-Length,
--      Content-Type match).
--   2. Range-downloaded Magic Bytes and verified MIME.
--   3. Moved/copied the object from temp/{token}/{filename} to
--      {final_category}/{uuid}.{ext}.
--
-- This RPC does NOT insert a storage_object_ref — that is done by
-- the existing uploadByPurpose flow which the finalize route calls
-- after this RPC. Keeping the concerns separate avoids coupling
-- the temp_uploads lifecycle to the storage_object_refs schema.
--
-- The RPC is idempotent: if called twice with the same token and
-- the row is already 'finalized', it returns the existing result
-- without error (but does NOT re-derive finalized_object_path).
-- ============================================================
create or replace function public.complete_temp_upload_finalize(
  p_token uuid,
  p_final_object_path text,
  p_final_bucket text default null
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
  if p_final_object_path is null or p_final_object_path = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_final_path');
  end if;

  select * into v_row from public.temp_uploads where id = p_token;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- Idempotency: if already finalized, return the existing result.
  if v_row.status = 'finalized' then
    return jsonb_build_object(
      'ok', true,
      'already_finalized', true,
      'row', to_jsonb(v_row)
    );
  end if;

  -- Only 'finalizing' rows can transition to 'finalized'.
  if v_row.status != 'finalizing' then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_status',
      'status', v_row.status
    );
  end if;

  -- If p_final_bucket is provided, validate it matches the row's
  -- final_bucket (defense-in-depth against route-level bugs).
  if p_final_bucket is not null and p_final_bucket != v_row.final_bucket then
    return jsonb_build_object(
      'ok', false,
      'error', 'bucket_mismatch',
      'expected', v_row.final_bucket,
      'actual', p_final_bucket
    );
  end if;

  update public.temp_uploads
  set
    status = 'finalized',
    finalized_object_path = p_final_object_path,
    finalized_at = now(),
    failure_reason = null
  where id = p_token and status = 'finalizing'
  returning * into v_row;

  if not found then
    -- Race: another request finalized or failed it between our
    -- SELECT and UPDATE.
    return jsonb_build_object('ok', false, 'error', 'race_finalized');
  end if;

  return jsonb_build_object('ok', true, 'row', to_jsonb(v_row));
end;
$$;

revoke all on function public.complete_temp_upload_finalize(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_temp_upload_finalize(uuid, text, text)
  to service_role;

-- ============================================================
-- F. fail_temp_upload_finalize
-- ------------------------------------------------------------
-- Phase 2 RPC, failure path: mark the temp_uploads row as failed
-- or rejected, and enqueue the temp object for cleanup.
--
-- The cleanup enqueue is handled by the application layer (which
-- calls enqueueStorageCleanup with reason='form_cancelled') so
-- that this RPC remains a pure state transition. The application
-- layer is responsible for calling enqueueStorageCleanup after
-- this RPC returns successfully.
--
-- Valid transitions:
--   finalizing → failed
--   finalizing → rejected
--   authorized → failed  (for expired/stale rows claimed by cleanup)
-- ============================================================
create or replace function public.fail_temp_upload_finalize(
  p_token uuid,
  p_reason text,
  p_outcome text default 'failed'
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.temp_uploads;
  v_status text;
begin
  if p_token is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_token');
  end if;
  if p_reason is null or p_reason = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_reason');
  end if;
  if p_outcome not in ('failed', 'rejected') then
    return jsonb_build_object('ok', false, 'error', 'invalid_outcome');
  end if;

  select status into v_status from public.temp_uploads where id = p_token;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- Idempotency: if already in a terminal state, return success.
  if v_status in ('failed', 'rejected') then
    return jsonb_build_object(
      'ok', true,
      'already_terminal', true,
      'status', v_status
    );
  end if;

  -- Only 'finalizing' or 'authorized' rows can be failed.
  if v_status not in ('finalizing', 'authorized') then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_status',
      'status', v_status
    );
  end if;

  update public.temp_uploads
  set
    status = p_outcome,
    failure_reason = p_reason
  where id = p_token and status in ('finalizing', 'authorized')
  returning * into v_row;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'race_failed');
  end if;

  return jsonb_build_object('ok', true, 'row', to_jsonb(v_row));
end;
$$;

revoke all on function public.fail_temp_upload_finalize(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.fail_temp_upload_finalize(uuid, text, text)
  to service_role;

-- ============================================================
-- G. recover_stale_temp_uploads
-- ------------------------------------------------------------
-- Maintenance RPC: reset rows stuck in 'finalizing' past the
-- stale threshold back to a recoverable state. Rows that have
-- been in 'finalizing' for longer than 2x the TTL (10 minutes)
-- are marked as 'failed' with reason='stale_finalizing'.
--
-- This RPC is intended to be called by the cleanup dispatcher
-- (or a periodic cron) to recover from crashed /finalize calls.
-- ============================================================
create or replace function public.recover_stale_temp_uploads(
  p_stale_threshold_seconds integer default 600
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_stale_threshold_seconds is null or p_stale_threshold_seconds < 60 then
    return jsonb_build_object('ok', false, 'error', 'invalid_threshold');
  end if;

  update public.temp_uploads
  set
    status = 'failed',
    failure_reason = 'stale_finalizing'
  where status = 'finalizing'
    and updated_at < now() - (p_stale_threshold_seconds || ' seconds')::interval;

  get diagnostics v_count = row_count;

  return jsonb_build_object(
    'ok', true,
    'recovered_count', v_count
  );
end;
$$;

revoke all on function public.recover_stale_temp_uploads(integer)
  from public, anon, authenticated;
grant execute on function public.recover_stale_temp_uploads(integer)
  to service_role;

-- ============================================================
-- H. reap_expired_temp_uploads
-- ------------------------------------------------------------
-- Maintenance RPC: mark rows with status='authorized' that have
-- passed their expires_at as 'failed' so the cleanup dispatcher
-- can delete the corresponding temp objects and rows.
--
-- This RPC does NOT delete rows — it only transitions status.
-- Row deletion is handled by the cleanup dispatcher after the
-- Storage object is confirmed deleted.
-- ============================================================
create or replace function public.reap_expired_temp_uploads(
  p_batch_limit integer default 100
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_batch_limit is null or p_batch_limit <= 0 or p_batch_limit > 1000 then
    return jsonb_build_object('ok', false, 'error', 'invalid_batch_limit');
  end if;

  update public.temp_uploads
  set
    status = 'failed',
    failure_reason = 'expired_authorized'
  where status = 'authorized'
    and expires_at <= now()
  limit p_batch_limit;

  get diagnostics v_count = row_count;

  return jsonb_build_object(
    'ok', true,
    'reaped_count', v_count
  );
end;
$$;

revoke all on function public.reap_expired_temp_uploads(integer)
  from public, anon, authenticated;
grant execute on function public.reap_expired_temp_uploads(integer)
  to service_role;
