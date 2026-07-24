-- ============================================================
-- Phase 14: Corrective migration for Storage RLS, Outbox RPC,
-- Provider idempotency, and Storage operation audit.
--
-- This migration is ADDITIVE only (new columns, new tables,
-- replaceable RPCs). No existing migration file is modified.
--
-- A. Storage RLS Policy correction:
--    The previous migration (20260725090000) attempted to delete
--    storage policies via a pattern match on the policy name
--    containing the 'authenticated' substring. This matched
--    nothing because the legacy policies are named
--    `public_assets_admin_write`, `public_assets_admin_update`,
--    `public_assets_admin_delete`, `private_assets_admin_all`.
--    This migration drops them by EXPLICIT name. After this,
--    anon/authenticated have NO INSERT/UPDATE/DELETE on
--    storage.objects. Only service_role writes (server-side API).
--
-- B. update_inquiry_with_audit RPC fix:
--    The previous version used dynamic SQL with a RETURNING clause
--    that referenced an undefined alias, and the return type
--    mismatched the %rowtype variable. This migration replaces
--    the function with static SQL using `returning * into v_row`
--    and explicit field updates.
--
-- C. Outbox claim condition fix:
--    The previous WHERE clause had wrong operator precedence —
--    `or` / `and` mixing without parentheses. This migration
--    replaces it with explicit grouping and uses
--    `make_interval(secs => v_safe_timeout)` instead of string
--    concatenation `(... || ' seconds')::interval`.
--    Also clears lock fields (lock_token, locked_at,
--    processing_started_at) on sent / retry / dead_letter so
--    stale lock state cannot leak across state transitions.
--
-- D. inquiry_outbox_deliveries table:
--    Per-event + per-provider delivery state so a successful
--    adapter is not re-invoked on every retry of the parent
--    event when another adapter fails.
--
-- E. admin_storage_operations table:
--    Append-only audit trail for Storage upload/delete with a
--    pending -> completed | failed state machine. Stores
--    metadata only — never file contents, secrets, or PII.
--
-- This migration is NOT executed in this commit.
-- ============================================================

-- ============================================================
-- A. Storage RLS Policy correction
-- ============================================================

-- A.1: Drop legacy admin write/update/delete policies by EXPLICIT name.
-- The previous pattern-based drop matched nothing because the
-- policies are named `*_admin_*`. Drop them explicitly so
-- anon/authenticated cannot INSERT/UPDATE/DELETE storage.objects
-- regardless of bucket.
drop policy if exists "public_assets_admin_write" on storage.objects;
drop policy if exists "public_assets_admin_update" on storage.objects;
drop policy if exists "public_assets_admin_delete" on storage.objects;
drop policy if exists "private_assets_admin_all" on storage.objects;

-- A.2: Defensive sweep — drop ANY remaining policy on storage.objects
-- that grants INSERT/UPDATE/DELETE to anon or authenticated.
-- This is belt-and-suspenders: it covers any future policy that
-- might be created by a misconfigured migration or seed file.
-- SELECT policies for anon on public-assets are preserved.
do $$
declare
  pol record;
begin
  for pol in
    select policyname, cmd, roles
      from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
       and cmd in ('INSERT', 'UPDATE', 'DELETE')
       and (
         roles is null
         or roles && array['anon'::name, 'authenticated'::name, 'public'::name]
       )
  loop
    execute format(
      'drop policy if exists %I on storage.objects',
      pol.policyname
    );
  end loop;
end $$;

-- A.3: Drop the SELECT policy on private-assets that might have been
-- created by an earlier migration/seed. anon must NOT read
-- private-assets. authenticated does not get blanket read either —
-- private asset access is mediated by signed URLs issued server-side.
do $$
declare
  pol record;
begin
  for pol in
    select policyname
      from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
       and cmd = 'SELECT'
       and (
         roles is null
         or roles && array['anon'::name, 'authenticated'::name, 'public'::name]
       )
  loop
    -- We re-create the anon read policy for public-assets below
    -- (A.4). Drop everything first to avoid duplicates.
    execute format(
      'drop policy if exists %I on storage.objects',
      pol.policyname
    );
  end loop;
end $$;

-- A.4: Recreate the only two policies that should exist:
--   1. service_role full access (belt-and-suspenders; service_role
--      bypasses RLS anyway)
--   2. anon SELECT on public-assets bucket only
-- authenticated gets NO direct storage policies — all writes go
-- through the server-side API (service_role), and private-asset
-- reads go through short-lived signed URLs.
create policy "service_role_all_storage" on storage.objects
  for all
  to service_role
  using (true)
  with check (true);

create policy "anon_read_public_assets_only" on storage.objects
  for select
  to anon
  using (bucket_id = 'public-assets');

-- ============================================================
-- B. update_inquiry_with_audit RPC fix (static SQL)
-- ============================================================
-- Replaces the dynamic-SQL version that referenced an undefined
-- alias in its RETURNING clause. Uses static SQL with
-- `returning * into v_row` so the %rowtype variable is correctly
-- populated. Field types come from the inquiries schema
-- (text / boolean / timestamptz).
create or replace function public.update_inquiry_with_audit(
  p_id uuid,
  p_patch jsonb,
  p_expected_updated_at timestamptz,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.inquiries%rowtype;
  v_field_list text := '';
begin
  -- Optimistic lock: row must exist AND updated_at must match.
  perform 1
    from public.inquiries
    where id = p_id
      and updated_at = p_expected_updated_at
    for update;
  if not found then
    -- Distinguish conflict (row exists, timestamp mismatch) from
    -- not-found so callers can map to 409 vs 404.
    perform 1 from public.inquiries where id = p_id;
    if found then
      raise exception 'optimistic lock conflict' using errcode = '40P01';
    else
      raise exception 'inquiry not found' using errcode = 'P0002';
    end if;
  end if;

  -- Whitelist: only these fields may be patched. Each CASE branch
  -- preserves the existing value when the key is absent from p_patch
  -- (so partial patches do not clobber untouched fields).
  if not (
    p_patch ? 'status'
    or p_patch ? 'is_read'
    or p_patch ? 'read_at'
    or p_patch ? 'notes'
    or p_patch ? 'assignee'
  ) then
    raise exception 'no valid fields' using errcode = '23502';
  end if;

  if p_patch ? 'status' then v_field_list := v_field_list || 'status, '; end if;
  if p_patch ? 'is_read' then v_field_list := v_field_list || 'is_read, '; end if;
  if p_patch ? 'read_at' then v_field_list := v_field_list || 'read_at, '; end if;
  if p_patch ? 'notes' then v_field_list := v_field_list || 'notes, '; end if;
  if p_patch ? 'assignee' then v_field_list := v_field_list || 'assignee, '; end if;

  -- Static UPDATE — no dynamic SQL, no undefined aliases.
  update public.inquiries
    set
      status = case
        when p_patch ? 'status' then (p_patch->>'status')::text
        else status
      end,
      is_read = case
        when p_patch ? 'is_read' then (p_patch->>'is_read')::boolean
        else is_read
      end,
      read_at = case
        when p_patch ? 'read_at' then nullif(p_patch->>'read_at', '')::timestamptz
        else read_at
      end,
      notes = case
        when p_patch ? 'notes' then nullif(p_patch->>'notes', '')
        else notes
      end,
      assignee = case
        when p_patch ? 'assignee' then nullif(p_patch->>'assignee', '')
        else assignee
      end,
      updated_at = now()
    where id = p_id
    returning * into v_row;

  -- Atomic audit log insert — no PII (no message/email/phone/wechat/
  -- whatsapp). If this fails, the entire transaction rolls back.
  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id,
    p_actor_email,
    p_actor_role,
    'inquiry.update',
    'inquiry',
    p_id::text,
    'Updated inquiry ' || p_id::text || ': ' || rtrim(v_field_list, ', ')
  );

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.update_inquiry_with_audit(uuid, jsonb, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.update_inquiry_with_audit(uuid, jsonb, timestamptz, uuid, text, text)
  to service_role;

-- ============================================================
-- C. Outbox claim / mark-sent / fail fixes
-- ============================================================

-- C.1: claim_inquiry_outbox_batch — fix operator precedence and
--      use make_interval(secs => ...) instead of string concat.
--
-- The previous WHERE was:
--   where (status in ('pending','retry') and next_retry_at <= now())
--      or (status = 'processing' and ... )
--        and attempts < max_attempts
--
-- Due to `and` binding tighter than `or`, the attempts filter only
-- applied to the processing branch. The correct form groups the two
-- claimable-state predicates with parens, then applies the attempts
-- filter to BOTH via an outer AND.
create or replace function public.claim_inquiry_outbox_batch(
  p_limit integer default 10,
  p_stale_timeout_seconds integer default 300
) returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_safe_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_safe_timeout integer := greatest(coalesce(p_stale_timeout_seconds, 300), 60);
  v_rows jsonb;
begin
  with picked as (
    select id
      from public.inquiry_outbox
      where (
        (
          status in ('pending', 'retry')
          and next_retry_at <= now()
        )
        or (
          status = 'processing'
          and processing_started_at is not null
          and processing_started_at < now() - make_interval(secs => v_safe_timeout)
        )
      )
      and attempts < max_attempts
      order by
        case
          when status in ('pending', 'retry') then 0
          else 1
        end,
        next_retry_at
      limit v_safe_limit
      for update skip locked
  ),
  marked as (
    update public.inquiry_outbox
      set status = 'processing',
          lock_token = gen_random_uuid(),
          locked_at = now(),
          processing_started_at = now(),
          updated_at = now()
      where id in (select id from picked)
      returning id, inquiry_id, lock_token
  )
  select jsonb_agg(to_jsonb(marked)) into v_rows
    from marked;

  return coalesce(v_rows, '[]'::jsonb);
end;
$$;

revoke all on function public.claim_inquiry_outbox_batch(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_inquiry_outbox_batch(integer, integer)
  to service_role;

-- C.2: mark_inquiry_outbox_sent — clear lock fields on success.
--      Previous version left lock_token / locked_at /
--      processing_started_at populated, which leaked stale lock
--      state into the sent row.
create or replace function public.mark_inquiry_outbox_sent(
  p_event_id uuid,
  p_lock_token uuid,
  p_provider_message_id text default null
) returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_event_id is null or p_lock_token is null then
    return false;
  end if;

  update public.inquiry_outbox
    set status = 'sent',
        sent_at = now(),
        last_error_code = null,
        provider_message_id = left(coalesce(p_provider_message_id, ''), 200),
        -- Clear lock fields so a sent row cannot be re-claimed by
        -- stale-lock-token tricks.
        lock_token = null,
        locked_at = null,
        processing_started_at = null,
        updated_at = now()
    where id = p_event_id
      and status = 'processing'
      and lock_token = p_lock_token;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.mark_inquiry_outbox_sent(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.mark_inquiry_outbox_sent(uuid, uuid, text)
  to service_role;

-- C.3: fail_inquiry_outbox_event — clear lock fields on retry and
--      dead_letter transitions. Previous version left lock_token /
--      locked_at / processing_started_at populated, which would
--      cause stale-token mismatches on subsequent claim attempts.
create or replace function public.fail_inquiry_outbox_event(
  p_event_id uuid,
  p_lock_token uuid,
  p_error_code text default null
) returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_attempts integer;
  v_max_attempts integer;
  v_final_status text;
begin
  if p_event_id is null or p_lock_token is null then
    return 'INVALID_PARAMS';
  end if;

  select attempts, max_attempts
    into v_attempts, v_max_attempts
    from public.inquiry_outbox
    where id = p_event_id
      and status = 'processing'
      and lock_token = p_lock_token
    for update;

  if not found then
    -- Event was re-claimed by another Worker or already completed.
    return 'NOT_FOUND_OR_TOKEN_MISMATCH';
  end if;

  v_attempts := v_attempts + 1;

  if v_attempts >= v_max_attempts then
    update public.inquiry_outbox
      set status = 'dead_letter',
          attempts = v_attempts,
          last_error_code = left(coalesce(p_error_code, 'unknown'), 80),
          next_retry_at = null,
          -- Clear lock fields on terminal state.
          lock_token = null,
          locked_at = null,
          processing_started_at = null,
          updated_at = now()
      where id = p_event_id;
    v_final_status := 'dead_letter';
  else
    update public.inquiry_outbox
      set status = 'retry',
          attempts = v_attempts,
          last_error_code = left(coalesce(p_error_code, 'unknown'), 80),
          next_retry_at = now() + least(
            make_interval(secs => 60) * power(2, v_attempts - 1),
            interval '30 minutes'
          ),
          -- Clear lock fields so the next claim_inquiry_outbox_batch
          -- can pick this row up cleanly.
          lock_token = null,
          locked_at = null,
          processing_started_at = null,
          updated_at = now()
      where id = p_event_id;
    v_final_status := 'retry';
  end if;

  return v_final_status;
end;
$$;

revoke all on function public.fail_inquiry_outbox_event(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_inquiry_outbox_event(uuid, uuid, text)
  to service_role;

-- ============================================================
-- D. inquiry_outbox_deliveries — per-provider delivery state
-- ============================================================
-- Without this table, a multi-adapter fan-out (wecom + email) where
-- ONE adapter fails causes the parent outbox event to retry, which
-- re-invokes BOTH adapters — including the one that already
-- succeeded. This table records per-(event, provider) delivery so
-- the processor can skip already-succeeded providers on retry.
--
-- Lifecycle:
--   pending  -> claimed (lock_token issued)
--            -> sent     (provider_message_id recorded)
--           \-> retry    (attempts++, next_retry_at scheduled)
--           \-> dead_letter (terminal, manual review)
--
-- Note: the parent outbox event remains the source of truth for
-- "notification delivered at least once". A delivery row is the
-- finer-grained "this specific provider accepted the message".
create table if not exists public.inquiry_outbox_deliveries (
  id uuid primary key default gen_random_uuid(),
  outbox_event_id uuid not null references public.inquiry_outbox(id) on delete cascade,
  provider text not null,                       -- 'wecom' | 'email' | ...
  status text not null default 'pending',       -- pending|claimed|sent|retry|dead_letter
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  lock_token uuid,
  locked_at timestamptz,
  processing_started_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error_code text,
  next_retry_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active delivery row per (event, provider). Pending/retry/sent
-- rows must be unique so a re-claim cannot create duplicates.
create unique index if not exists uq_outbox_deliveries_event_provider_active
  on public.inquiry_outbox_deliveries(outbox_event_id, provider)
  where status in ('pending', 'claimed', 'retry');

create index if not exists idx_outbox_deliveries_status_retry
  on public.inquiry_outbox_deliveries(status, next_retry_at)
  where status in ('pending', 'retry');

create index if not exists idx_outbox_deliveries_event
  on public.inquiry_outbox_deliveries(outbox_event_id);

alter table public.inquiry_outbox_deliveries enable row level security;

-- No policies => anon/authenticated have NO access. Only service_role
-- (which bypasses RLS) can read/write this table.
revoke all on table public.inquiry_outbox_deliveries from public, anon, authenticated;
grant all on table public.inquiry_outbox_deliveries to service_role;

-- D.1: claim_inquiry_outbox_deliveries(limit)
--      Returns pending/retry delivery rows with a fresh lock_token.
--      Called by the processor BEFORE invoking adapters, so it can
--      skip providers that are already in 'sent' state.
create or replace function public.claim_inquiry_outbox_deliveries(
  p_limit integer default 20,
  p_stale_timeout_seconds integer default 300
) returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_safe_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_safe_timeout integer := greatest(coalesce(p_stale_timeout_seconds, 300), 60);
  v_rows jsonb;
begin
  with picked as (
    select id
      from public.inquiry_outbox_deliveries
      where (
        (
          status in ('pending', 'retry')
          and next_retry_at <= now()
        )
        or (
          status = 'claimed'
          and processing_started_at is not null
          and processing_started_at < now() - make_interval(secs => v_safe_timeout)
        )
      )
      and attempts < max_attempts
      order by next_retry_at
      limit v_safe_limit
      for update skip locked
  ),
  marked as (
    update public.inquiry_outbox_deliveries
      set status = 'claimed',
          lock_token = gen_random_uuid(),
          locked_at = now(),
          processing_started_at = now(),
          updated_at = now()
      where id in (select id from picked)
      returning id, outbox_event_id, provider, lock_token
  )
  select jsonb_agg(to_jsonb(marked)) into v_rows
    from marked;

  return coalesce(v_rows, '[]'::jsonb);
end;
$$;

revoke all on function public.claim_inquiry_outbox_deliveries(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_inquiry_outbox_deliveries(integer, integer)
  to service_role;

-- D.2: mark_delivery_sent(event_id, provider, lock_token, provider_message_id)
--      Marks a single (event, provider) delivery as sent. Clears
--      lock fields. Returns false on token mismatch.
create or replace function public.mark_delivery_sent(
  p_delivery_id uuid,
  p_lock_token uuid,
  p_provider_message_id text default null
) returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_updated integer;
  v_event_id uuid;
begin
  if p_delivery_id is null or p_lock_token is null then
    return false;
  end if;

  update public.inquiry_outbox_deliveries
    set status = 'sent',
        sent_at = now(),
        provider_message_id = left(coalesce(p_provider_message_id, ''), 200),
        last_error_code = null,
        lock_token = null,
        locked_at = null,
        processing_started_at = null,
        updated_at = now()
    where id = p_delivery_id
      and status = 'claimed'
      and lock_token = p_lock_token
    returning outbox_event_id into v_event_id;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return false;
  end if;

  -- If all deliveries for the parent event are now 'sent', mark
  -- the parent outbox event as sent too. This is how the parent
  -- event tracks overall completion.
  perform 1
    from public.inquiry_outbox_deliveries
    where outbox_event_id = v_event_id
      and status <> 'sent'
    limit 1;
  if not found then
    update public.inquiry_outbox
      set status = 'sent',
          sent_at = now(),
          last_error_code = null,
          lock_token = null,
          locked_at = null,
          processing_started_at = null,
          updated_at = now()
      where id = v_event_id
        and status in ('processing', 'pending', 'retry');
  end if;

  return true;
end;
$$;

revoke all on function public.mark_delivery_sent(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.mark_delivery_sent(uuid, uuid, text)
  to service_role;

-- D.3: fail_delivery_event(delivery_id, lock_token, error_code)
--      Advances attempts; clears lock fields on retry and dead_letter.
create or replace function public.fail_delivery_event(
  p_delivery_id uuid,
  p_lock_token uuid,
  p_error_code text default null
) returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_attempts integer;
  v_max_attempts integer;
  v_final_status text;
  v_event_id uuid;
begin
  if p_delivery_id is null or p_lock_token is null then
    return 'INVALID_PARAMS';
  end if;

  select attempts, max_attempts, outbox_event_id
    into v_attempts, v_max_attempts, v_event_id
    from public.inquiry_outbox_deliveries
    where id = p_delivery_id
      and status = 'claimed'
      and lock_token = p_lock_token
    for update;

  if not found then
    return 'NOT_FOUND_OR_TOKEN_MISMATCH';
  end if;

  v_attempts := v_attempts + 1;

  if v_attempts >= v_max_attempts then
    update public.inquiry_outbox_deliveries
      set status = 'dead_letter',
          attempts = v_attempts,
          last_error_code = left(coalesce(p_error_code, 'unknown'), 80),
          next_retry_at = null,
          lock_token = null,
          locked_at = null,
          processing_started_at = null,
          updated_at = now()
      where id = p_delivery_id;
    v_final_status := 'dead_letter';
  else
    update public.inquiry_outbox_deliveries
      set status = 'retry',
          attempts = v_attempts,
          last_error_code = left(coalesce(p_error_code, 'unknown'), 80),
          next_retry_at = now() + least(
            make_interval(secs => 60) * power(2, v_attempts - 1),
            interval '30 minutes'
          ),
          lock_token = null,
          locked_at = null,
          processing_started_at = null,
          updated_at = now()
      where id = p_delivery_id;
    v_final_status := 'retry';
  end if;

  -- If ANY delivery for the parent event is dead_letter, mark the
  -- parent as failed (dead_letter) too so it surfaces for review.
  -- Otherwise leave the parent in 'processing' — other providers
  -- may still succeed.
  if v_final_status = 'dead_letter' then
    update public.inquiry_outbox
      set status = 'dead_letter',
          last_error_code = left(
            coalesce(p_error_code, 'PROVIDER_DEAD_LETTER'), 80
          ),
          next_retry_at = null,
          lock_token = null,
          locked_at = null,
          processing_started_at = null,
          updated_at = now()
      where id = v_event_id
        and status in ('processing', 'pending', 'retry');
  end if;

  return v_final_status;
end;
$$;

revoke all on function public.fail_delivery_event(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_delivery_event(uuid, uuid, text)
  to service_role;

-- ============================================================
-- E. admin_storage_operations — Storage audit trail
-- ============================================================
-- Append-only audit log for Storage upload/delete. Records
-- metadata ONLY: actor, action, bucket, path, MIME, size, SHA-256,
-- status, error_code. NEVER records file contents, secrets, or
-- customer PII (no inquiry phone/email/message).
--
-- State machine:
--   pending   -> created when the operation starts (before bytes
--                hit the bucket)
--   completed -> set after the storage write/delete succeeds
--   failed    -> set if the storage write/delete errors
--
-- The application-side server API records transitions; the table
-- itself does not drive the storage operation.
create table if not exists public.admin_storage_operations (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,                               -- admin user id (nullable for system)
  actor_role text,                             -- 'admin' | 'editor' | 'super_admin' | 'system'
  action text not null,                        -- 'storage.upload' | 'storage.delete'
  bucket text not null,                        -- 'public-assets' | 'private-assets'
  object_path text not null,                   -- '{category}/{uuid}.{ext}'
  mime_type text,                              -- 'application/pdf' | 'image/jpeg' | ...
  size_bytes bigint,                           -- file size in bytes (null for delete)
  sha256 text,                                 -- hex SHA-256 of file bytes (null for delete)
  status text not null default 'pending',      -- pending|completed|failed
  error_code text,                             -- server-side log code on failure
  created_at timestamptz not null default now(),
  completed_at timestamptz                     -- set when status leaves pending
);

create index if not exists idx_admin_storage_ops_created_at
  on public.admin_storage_operations (created_at desc);
create index if not exists idx_admin_storage_ops_actor
  on public.admin_storage_operations (actor_id);
create index if not exists idx_admin_storage_ops_target
  on public.admin_storage_operations (bucket, object_path);
create index if not exists idx_admin_storage_ops_status
  on public.admin_storage_operations (status)
  where status = 'pending';

alter table public.admin_storage_operations enable row level security;

-- No policies => anon/authenticated have NO access. Only service_role
-- can read/write (via the server-side API).
revoke all on table public.admin_storage_operations from public, anon, authenticated;
grant all on table public.admin_storage_operations to service_role;

-- E.1: record_storage_operation_started — inserts a pending row
--      BEFORE the storage write. Returns the operation id so the
--      caller can update it on success/failure.
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
  if v_action not in ('storage.upload', 'storage.delete') then
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

-- E.2: complete_storage_operation — marks a pending operation as
--      completed or failed. Sets completed_at. Does NOT record
--      file contents or PII — only an opaque error_code on failure.
create or replace function public.complete_storage_operation(
  p_operation_id uuid,
  p_success boolean,
  p_error_code text default null
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_operation_id is null then
    return false;
  end if;

  update public.admin_storage_operations
    set status = case when p_success then 'completed' else 'failed' end,
        error_code = case when p_success then null else left(coalesce(p_error_code, 'unknown'), 80) end,
        completed_at = now()
    where id = p_operation_id
      and status = 'pending';

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.complete_storage_operation(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.complete_storage_operation(uuid, boolean, text)
  to service_role;

-- ============================================================
-- End of migration
-- ============================================================
