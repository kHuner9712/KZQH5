-- ============================================================
-- Migration 20260725110000
-- Per-provider Outbox delivery runtime + Storage lifecycle
-- ============================================================
-- This migration:
--   1. Adds provider initialization columns to inquiry_outbox.
--   2. Replaces the partial unique index on inquiry_outbox_deliveries
--      with an UNCONDITIONAL unique constraint (one delivery row per
--      event+provider, across ALL statuses).
--   3. Adds initialize_inquiry_outbox_deliveries RPC.
--   4. Adds storage_cleanup_queue table + claim/cleanup RPCs.
--   5. Adds check_storage_object_referenced RPC (reference check
--      before delete).
--   6. Adds publish_catalog_asset RPC (private→public copy).
--   7. Deprecates (does NOT drop) the old parent-level claim/mark/fail
--      RPCs — they remain for backward compat but must not be called
--      by the new per-provider runtime.
-- ============================================================

-- ============================================================
-- A. inquiry_outbox: provider initialization columns
-- ============================================================
alter table public.inquiry_outbox
  add column if not exists providers_initialized_at timestamptz,
  add column if not exists configured_provider_count integer not null default 0;

comment on column public.inquiry_outbox.providers_initialized_at is
  'When delivery rows were created for this event. NULL = not yet initialized.';

comment on column public.inquiry_outbox.configured_provider_count is
  'Number of providers configured at initialization time. 0 = NOTIFICATION_NOT_CONFIGURED.';

-- ============================================================
-- B. inquiry_outbox_deliveries: UNCONDITIONAL unique constraint
-- ============================================================
-- The old partial unique index only prevented duplicates among
-- pending/claimed/retry rows. This allowed multiple sent or
-- dead_letter rows for the same (event, provider), breaking the
-- "one delivery row per event+provider" invariant.
--
-- We replace it with an unconditional unique constraint so that
-- exactly ONE delivery row exists per (event, provider) across
-- ALL statuses (pending, claimed, sent, retry, dead_letter).
--
-- Before creating the constraint, we check for existing duplicates.
-- If duplicates are found, the migration FAILS (raise_exception)
-- rather than silently deleting data — fail-closed.

drop index if exists public.uq_outbox_deliveries_event_provider_active;

do $$
declare
  v_dup_count integer;
begin
  select count(*) into v_dup_count
    from (
      select outbox_event_id, provider
        from public.inquiry_outbox_deliveries
       group by outbox_event_id, provider
      having count(*) > 1
    ) dups;

  if v_dup_count > 0 then
    raise exception 'Cannot create unconditional unique constraint: % duplicate (event, provider) delivery rows found. Manual data reconciliation required before migration.',
      v_dup_count using errcode = 'check_violation';
  end if;
end;
$$;

alter table public.inquiry_outbox_deliveries
  add constraint uq_outbox_deliveries_event_provider
  unique (outbox_event_id, provider);

-- Add attempts to the claim RPC return so the processor can pass
-- the real attempt number (not hardcoded 1) to adapters.
-- The existing claim_inquiry_outbox_deliveries returns
-- {id, outbox_event_id, provider, lock_token}. We replace it to
-- also return attempts and max_attempts.
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
      returning id, outbox_event_id, provider, lock_token, attempts, max_attempts
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

-- ============================================================
-- C. initialize_inquiry_outbox_deliveries RPC
-- ============================================================
-- Called by the processor BEFORE claiming deliveries. Creates one
-- delivery row per configured provider for events that haven't been
-- initialized yet.
--
-- Provider list comes from the server (p_providers text[]) — the
-- browser NEVER supplies providers. Only 'email' and 'wecom' are
-- allowed (whitelist enforced).
--
-- Uses INSERT ... ON CONFLICT DO NOTHING so re-calling is safe.
-- Updates the parent event's providers_initialized_at and
-- configured_provider_count.
create or replace function public.initialize_inquiry_outbox_deliveries(
  p_outbox_event_id uuid,
  p_providers text[]
) returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_provider text;
  v_count integer := 0;
  v_event_exists boolean;
begin
  if p_outbox_event_id is null or p_providers is null then
    return -1;
  end if;

  -- Check the parent event exists and hasn't been initialized yet.
  perform 1 from public.inquiry_outbox
    where id = p_outbox_event_id
    limit 1;
  if not found then
    return -1;
  end if;

  select providers_initialized_at is not null into v_event_exists
    from public.inquiry_outbox
    where id = p_outbox_event_id
    limit 1;
  if v_event_exists then
    -- Already initialized — idempotent no-op.
    return 0;
  end if;

  -- Insert one delivery row per whitelisted provider.
  foreach v_provider in array p_providers loop
    -- Whitelist: only 'email' and 'wecom' are allowed.
    if v_provider in ('email', 'wecom') then
      insert into public.inquiry_outbox_deliveries
        (outbox_event_id, provider, status, attempts, max_attempts, next_retry_at)
      values
        (p_outbox_event_id, v_provider, 'pending', 0, 5, now())
      on conflict (outbox_event_id, provider) do nothing;

      v_count := v_count + 1;
    end if;
  end loop;

  -- Mark the parent event as initialized and transition to 'processing'
  -- so the parent reflects that deliveries are in-flight. If no
  -- provider was configured (v_count = 0), the parent goes to
  -- 'dead_letter' with NOTIFICATION_NOT_CONFIGURED — the processor
  -- does NOT need to call mark_inquiry_outbox_not_configured in
  -- this case (but may still call it for events discovered later).
  if v_count = 0 then
    update public.inquiry_outbox
      set providers_initialized_at = now(),
          configured_provider_count = 0,
          status = 'dead_letter',
          last_error_code = 'NOTIFICATION_NOT_CONFIGURED',
          next_retry_at = null,
          lock_token = null,
          locked_at = null,
          processing_started_at = null,
          updated_at = now()
      where id = p_outbox_event_id
        and providers_initialized_at is null;
  else
    update public.inquiry_outbox
      set providers_initialized_at = now(),
          configured_provider_count = v_count,
          status = 'processing',
          updated_at = now()
      where id = p_outbox_event_id
        and providers_initialized_at is null;
  end if;

  return v_count;
end;
$$;

revoke all on function public.initialize_inquiry_outbox_deliveries(uuid, text[])
  from public, anon, authenticated;
grant execute on function public.initialize_inquiry_outbox_deliveries(uuid, text[])
  to service_role;

-- ============================================================
-- D. find_uninitialized_outbox_events RPC
-- ============================================================
-- Returns event IDs that have not yet had their delivery rows
-- initialized. The processor calls this before claiming deliveries.
create or replace function public.find_uninitialized_outbox_events(
  p_limit integer default 20
) returns uuid[]
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_safe_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_ids uuid[];
begin
  select array_agg(id) into v_ids
    from public.inquiry_outbox
    where providers_initialized_at is null
      and status in ('pending', 'processing', 'retry')
    order by created_at
    limit v_safe_limit;

  return coalesce(v_ids, '{}'::uuid[]);
end;
$$;

revoke all on function public.find_uninitialized_outbox_events(integer)
  from public, anon, authenticated;
grant execute on function public.find_uninitialized_outbox_events(integer)
  to service_role;

-- ============================================================
-- E. mark_inquiry_outbox_not_configured RPC
-- ============================================================
-- When no provider is configured, the parent event goes directly
-- to dead_letter with error code NOTIFICATION_NOT_CONFIGURED.
-- No delivery rows are created.
create or replace function public.mark_inquiry_outbox_not_configured(
  p_event_id uuid,
  p_lock_token uuid default null
) returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if p_event_id is null then
    return false;
  end if;

  update public.inquiry_outbox
    set status = 'dead_letter',
        last_error_code = 'NOTIFICATION_NOT_CONFIGURED',
        providers_initialized_at = now(),
        configured_provider_count = 0,
        next_retry_at = null,
        lock_token = null,
        locked_at = null,
        processing_started_at = null,
        updated_at = now()
    where id = p_event_id
      and status in ('pending', 'processing', 'retry');

  return found;
end;
$$;

revoke all on function public.mark_inquiry_outbox_not_configured(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_inquiry_outbox_not_configured(uuid, uuid)
  to service_role;

-- ============================================================
-- F. storage_cleanup_queue table
-- ============================================================
-- Tracks orphaned Storage objects that need deletion. Objects enter
-- the queue when:
--   - A form is cancelled after uploading a new (unpersisted) file.
--   - A persisted object is replaced and the old object is no longer
--     referenced by any DB row.
--   - A DB row is deleted and the associated Storage object needs
--     cleanup.
--
-- The cleanup dispatcher (not yet deployed — BLOCK) claims rows with
-- FOR UPDATE SKIP LOCKED, re-checks references, and deletes.
create table if not exists public.storage_cleanup_queue (
  id uuid primary key default gen_random_uuid(),
  bucket text not null,                          -- 'public-assets' | 'private-assets'
  object_path text not null,                     -- '{category}/{uuid}.{ext}'
  reason text not null,                          -- 'form_cancelled' | 'replaced' | 'row_deleted' | 'orphan_detected'
  source_type text,                              -- 'product_image' | 'certificate' | 'catalog_asset' | ...
  source_id uuid,                                -- the DB row id that owned the object (nullable)
  status text not null default 'pending',        -- pending|claimed|retry|completed|dead_letter
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  lock_token uuid,
  locked_at timestamptz,
  next_retry_at timestamptz not null default now(),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

-- One active row per (bucket, object_path) to prevent duplicate
-- cleanup of the same object. 'retry' is included so a retrying
-- row blocks new enqueue until it terminates.
create unique index if not exists uq_storage_cleanup_active
  on public.storage_cleanup_queue(bucket, object_path)
  where status in ('pending', 'claimed', 'retry');

create index if not exists idx_storage_cleanup_status_retry
  on public.storage_cleanup_queue(status, next_retry_at)
  where status in ('pending', 'retry');

create index if not exists idx_storage_cleanup_target
  on public.storage_cleanup_queue(bucket, object_path);

alter table public.storage_cleanup_queue enable row level security;

revoke all on table public.storage_cleanup_queue
  from public, anon, authenticated;
grant all on table public.storage_cleanup_queue to service_role;

-- ============================================================
-- G. enqueue_storage_cleanup RPC
-- ============================================================
-- Adds an object to the cleanup queue. Idempotent: if a pending
-- cleanup for the same (bucket, path) already exists, does nothing.
create or replace function public.enqueue_storage_cleanup(
  p_bucket text,
  p_object_path text,
  p_reason text,
  p_source_type text default null,
  p_source_id uuid default null
) returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_bucket not in ('public-assets', 'private-assets') then
    raise exception 'Invalid bucket' using errcode = 'check_violation';
  end if;
  if p_object_path is null or length(p_object_path) = 0 then
    raise exception 'Invalid object_path' using errcode = 'check_violation';
  end if;

  insert into public.storage_cleanup_queue
    (bucket, object_path, reason, source_type, source_id, status, next_retry_at)
  values
    (p_bucket, p_object_path, p_reason, p_source_type, p_source_id, 'pending', now())
  on conflict (bucket, object_path) where status in ('pending', 'claimed', 'retry') do nothing
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.enqueue_storage_cleanup(text, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.enqueue_storage_cleanup(text, text, text, text, uuid)
  to service_role;

-- ============================================================
-- H. check_storage_object_referenced RPC
-- ============================================================
-- Checks whether a storage path is referenced by any business table
-- before allowing deletion. Returns true if referenced (delete should
-- be refused), false if safe to delete.
--
-- We check the known URL columns across products, product_images,
-- product_assets, certificates, and projects. Since URLs are stored
-- as bare text, we do a LIKE match on the path suffix.
create or replace function public.check_storage_object_referenced(
  p_bucket text,
  p_object_path text
) returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_pattern text;
  v_count integer;
begin
  if p_object_path is null or length(p_object_path) = 0 then
    return true; -- refuse delete if path is invalid
  end if;

  -- Build a LIKE pattern matching any URL ending with this path.
  v_pattern := '%' || p_object_path;

  -- Check products.cover_image_url / video_url
  select count(*) into v_count from public.products
    where cover_image_url like v_pattern
       or video_url like v_pattern;
  if v_count > 0 then return true; end if;

  -- Check product_images.image_url
  select count(*) into v_count from public.product_images
    where image_url like v_pattern;
  if v_count > 0 then return true; end if;

  -- Check product_assets.file_url / cover_image_url
  select count(*) into v_count from public.product_assets
    where file_url like v_pattern
       or cover_image_url like v_pattern;
  if v_count > 0 then return true; end if;

  -- Check certificates.image_url
  select count(*) into v_count from public.certificates
    where image_url like v_pattern;
  if v_count > 0 then return true; end if;

  -- Check projects.cover_image_url / video_url
  select count(*) into v_count from public.projects
    where cover_image_url like v_pattern
       or video_url like v_pattern;
  if v_count > 0 then return true; end if;

  return false;
end;
$$;

revoke all on function public.check_storage_object_referenced(text, text)
  from public, anon, authenticated;
grant execute on function public.check_storage_object_referenced(text, text)
  to service_role;

-- ============================================================
-- I. claim_storage_cleanup RPC
-- ============================================================
-- Claims a batch of cleanup queue rows for processing.
create or replace function public.claim_storage_cleanup(
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
      from public.storage_cleanup_queue
      where (
        (status in ('pending', 'retry') and next_retry_at <= now())
        or (status = 'claimed' and locked_at is not null
            and locked_at < now() - make_interval(secs => v_safe_timeout))
      )
      and attempts < max_attempts
      order by next_retry_at
      limit v_safe_limit
      for update skip locked
  ),
  marked as (
    update public.storage_cleanup_queue
      set status = 'claimed',
          lock_token = gen_random_uuid(),
          locked_at = now(),
          updated_at = now()
      where id in (select id from picked)
      returning id, bucket, object_path, lock_token
  )
  select jsonb_agg(to_jsonb(marked)) into v_rows
    from marked;

  return coalesce(v_rows, '[]'::jsonb);
end;
$$;

revoke all on function public.claim_storage_cleanup(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_storage_cleanup(integer, integer)
  to service_role;

-- ============================================================
-- J. complete_storage_cleanup RPC
-- ============================================================
-- Marks a cleanup row as completed or failed (retry/dead_letter).
create or replace function public.complete_storage_cleanup(
  p_cleanup_id uuid,
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
  v_attempts integer;
  v_max_attempts integer;
begin
  if p_cleanup_id is null or p_lock_token is null then
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
          updated_at = now()
      where id = p_cleanup_id;
    return 'retry';
  end if;
end;
$$;

revoke all on function public.complete_storage_cleanup(uuid, uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.complete_storage_cleanup(uuid, uuid, boolean, text)
  to service_role;

-- ============================================================
-- K. fail_delivery_event (redefined with p_force_dead_letter)
-- ============================================================
-- Redefined from the 20260725100000 version to add p_force_dead_letter.
-- When true, the delivery goes directly to dead_letter regardless of
-- attempts — used for PERMANENT notification failures (e.g. Resend
-- 409 invalid idempotent request) that must NOT be retried.
create or replace function public.fail_delivery_event(
  p_delivery_id uuid,
  p_lock_token uuid,
  p_error_code text default null,
  p_force_dead_letter boolean default false
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

  if p_force_dead_letter or v_attempts >= v_max_attempts then
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
  -- parent as dead_letter too so it surfaces for review. Otherwise
  -- leave the parent in 'processing' — other providers may still
  -- succeed.
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

revoke all on function public.fail_delivery_event(uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.fail_delivery_event(uuid, uuid, text, boolean)
  to service_role;

-- ============================================================
-- L. publish_catalog_asset RPC
-- ============================================================
-- Atomically transitions a Catalog asset's file_url (and optional
-- cover_image_url) from a private-assets path to a public-assets
-- path after the application layer has copied the bytes.
--
-- Pre-conditions (validated HERE, in the DB transaction):
--   - asset row exists
--   - access_level = 'public'
--   - authorization_status = 'confirmed'
--   - is_published = true
--
-- The RPC returns the OLD file_url and OLD cover_image_url so the
-- caller can enqueue private-source cleanup AFTER the DB commits.
-- The caller MUST NOT delete the private source before this RPC
-- commits.
--
-- Audit: inserts an admin_audit_log row in the same transaction.
-- If the audit insert fails, the publish update rolls back.
create or replace function public.publish_catalog_asset(
  p_asset_id uuid,
  p_public_file_url text,
  p_public_cover_image_url text default null,
  p_actor_id uuid default null,
  p_actor_email text default null,
  p_actor_role text default null
) returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_old_file_url text;
  v_old_cover_image_url text;
  v_title_cn text;
  v_access_level text;
  v_auth_status text;
  v_is_published boolean;
begin
  if p_asset_id is null or p_public_file_url is null or btrim(p_public_file_url) = '' then
    raise exception 'asset_id and public_file_url required' using errcode = '23502';
  end if;

  -- Lock the row for the duration of this transaction.
  select file_url, cover_image_url, title_cn, access_level, authorization_status, is_published
    into v_old_file_url, v_old_cover_image_url, v_title_cn, v_access_level, v_auth_status, v_is_published
    from public.product_assets
    where id = p_asset_id
    for update;

  if not found then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;

  -- Enforce the publication gate. A draft, restricted, or
  -- unconfirmed asset MUST NOT be publishable to public-assets.
  if v_access_level <> 'public' then
    raise exception 'asset access_level must be public' using errcode = '23001';
  end if;
  if v_auth_status <> 'confirmed' then
    raise exception 'asset authorization_status must be confirmed' using errcode = '23001';
  end if;
  if not v_is_published then
    raise exception 'asset must be is_published=true' using errcode = '23001';
  end if;

  -- Apply the URL transition.
  update public.product_assets
    set file_url = p_public_file_url,
        cover_image_url = coalesce(p_public_cover_image_url, cover_image_url),
        updated_at = now()
    where id = p_asset_id;

  -- Atomic audit log. No PII — only metadata.
  insert into public.admin_audit_log (
    actor_id, actor_email, actor_role, action, target_type, target_id, summary
  ) values (
    p_actor_id,
    p_actor_email,
    p_actor_role,
    'catalog_asset.publish',
    'product_asset',
    p_asset_id::text,
    'Published catalog asset ' || p_asset_id::text || ' (' || left(coalesce(v_title_cn, ''), 60) || ') to public-assets'
  );

  return jsonb_build_object(
    'asset_id', p_asset_id,
    'old_file_url', v_old_file_url,
    'old_cover_image_url', v_old_cover_image_url,
    'new_file_url', p_public_file_url,
    'new_cover_image_url', coalesce(p_public_cover_image_url, v_old_cover_image_url)
  );
end;
$$;

revoke all on function public.publish_catalog_asset(uuid, text, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.publish_catalog_asset(uuid, text, text, uuid, text, text)
  to service_role;

-- ============================================================
-- M. Deprecation comments on old parent-level RPCs
-- ============================================================
-- The following RPCs are DEPRECATED and must NOT be called by the
-- new per-provider outbox processor:
--   - claim_inquiry_outbox_batch
--   - mark_inquiry_outbox_sent
--   - fail_inquiry_outbox_event
-- They remain in the schema for backward compatibility and for
-- tests that verify they are not re-introduced into the runtime
-- call path. The new runtime uses:
--   - find_uninitialized_outbox_events
--   - initialize_inquiry_outbox_deliveries
--   - claim_inquiry_outbox_deliveries
--   - mark_delivery_sent
--   - fail_delivery_event
--   - mark_inquiry_outbox_not_configured
comment on function public.claim_inquiry_outbox_batch(integer, integer) is
  'DEPRECATED. Use claim_inquiry_outbox_deliveries for per-provider delivery.';
comment on function public.mark_inquiry_outbox_sent(uuid, uuid, text) is
  'DEPRECATED. Use mark_delivery_sent for per-provider delivery.';
comment on function public.fail_inquiry_outbox_event(uuid, uuid, text) is
  'DEPRECATED. Use fail_delivery_event for per-provider delivery.';
