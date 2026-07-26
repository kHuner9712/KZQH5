-- ============================================================
-- Phase 15: Per-provider Outbox delivery + Storage lifecycle
--            integration tests.
--
-- Proves:
--   D. Per-provider delivery model (inquiry_outbox_deliveries):
--      1.  initialize_inquiry_outbox_deliveries creates one row per
--          whitelisted provider and transitions parent to 'processing'.
--      2.  initialize is idempotent (re-call is a no-op).
--      3.  initialize with zero providers marks parent as
--          'dead_letter' with NOTIFICATION_NOT_CONFIGURED.
--      4.  initialize rejects unwhitelisted providers (silently skipped).
--      5.  find_uninitialized_outbox_events returns only uninitialized
--          events.
--      6.  claim_inquiry_outbox_deliveries returns rows with attempts
--          and max_attempts fields.
--      7.  claim skips rows with attempts >= max_attempts.
--      8.  claim re-claims stale 'claimed' rows after timeout.
--      9.  claim does NOT re-claim fresh 'claimed' rows.
--      10. mark_delivery_sent with correct token succeeds and clears
--          lock fields.
--      11. mark_delivery_sent with wrong token returns false.
--      12. mark_delivery_sent marks parent as 'sent' only when ALL
--          deliveries are sent.
--      13. fail_delivery_event with force_dead_letter=true forces
--          dead_letter regardless of attempts.
--      14. fail_delivery_event marks parent as 'dead_letter' when any
--          delivery is dead_letter.
--      15. fail_delivery_event clears lock fields on retry and
--          dead_letter transitions.
--      16. Unconditional unique constraint prevents duplicate
--          (event, provider) rows across ALL statuses.
--      17. mark_inquiry_outbox_not_configured transitions event to
--          dead_letter with NOTIFICATION_NOT_CONFIGURED.
--
--   S. Storage lifecycle (storage_cleanup_queue + RPCs):
--      1.  check_storage_object_referenced returns true when path is
--          referenced by products.cover_image_url.
--      2.  check_storage_object_referenced returns true when path is
--          referenced by product_assets.file_url.
--      3.  check_storage_object_referenced returns false for
--          unreferenced path.
--      4.  check_storage_object_referenced refuses delete (returns
--          true) on empty/invalid path.
--      5.  enqueue_storage_cleanup inserts a pending row.
--      6.  enqueue_storage_cleanup is idempotent (no duplicate
--          pending rows for same bucket+path).
--      7.  enqueue_storage_cleanup rejects invalid bucket.
--      8.  claim_storage_cleanup claims pending rows with lock_token.
--      9.  claim_storage_cleanup re-claims stale claimed rows.
--      10. complete_storage_cleanup with success marks completed and
--          clears lock fields.
--      11. complete_storage_cleanup with failure transitions to retry
--          with exponential backoff.
--      12. complete_storage_cleanup transitions to dead_letter after
--          max_attempts.
--      13. complete_storage_cleanup with wrong token returns
--          NOT_FOUND_OR_TOKEN_MISMATCH.
--      14. RLS: anon CANNOT read storage_cleanup_queue.
--      15. RLS: authenticated CANNOT read storage_cleanup_queue.
--
--   P. publish_catalog_asset RPC:
--      1.  Rejects asset with access_level != 'public'.
--      2.  Rejects asset with authorization_status != 'confirmed'.
--      3.  Rejects asset with is_published = false.
--      4.  Rejects nonexistent asset id (P0002).
--      5.  Succeeds and returns old + new URLs.
--      6.  Inserts audit log row in the same transaction.
--
-- All tests use deterministic UUIDs and roll back.
-- ============================================================

-- ============================================================
-- D. Per-provider delivery model
-- ============================================================

begin;
-- Seed an inquiry to satisfy the FK on inquiry_outbox.
set local role service_role;
insert into public.inquiries (id, name, status, language, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000000b0', '[PER-PROVIDER TEST]', 'new', 'zh', now(), now())
on conflict (id) do nothing;

-- D.1: initialize creates one row per whitelisted provider.
insert into public.inquiry_outbox (
  id, inquiry_id, event_type, status, attempts, max_attempts, next_retry_at
) values (
  '00000000-0000-4000-8000-0000000000b1',
  '00000000-0000-4000-8000-0000000000b0',
  'inquiry_created', 'pending', 0, 5, now()
)
on conflict (id) do nothing;

do $$
declare
  v_count integer;
  v_provider_count integer;
  v_status text;
begin
  v_count := public.initialize_inquiry_outbox_deliveries(
    '00000000-0000-4000-8000-0000000000b1'::uuid,
    array['email', 'wecom']::text[]
  );
  if v_count <> 2 then
    raise exception 'D.1: initialize should create 2 deliveries, got %', v_count;
  end if;

  select configured_provider_count into v_provider_count
    from public.inquiry_outbox
    where id = '00000000-0000-4000-8000-0000000000b1';
  if v_provider_count <> 2 then
    raise exception 'D.1: configured_provider_count should be 2, got %', v_provider_count;
  end if;

  select status into v_status from public.inquiry_outbox
    where id = '00000000-0000-4000-8000-0000000000b1';
  if v_status <> 'processing' then
    raise exception 'D.1: parent status should be processing, got %', v_status;
  end if;
end $$;

-- D.2: initialize is idempotent (re-call is a no-op).
do $$
declare
  v_count integer;
begin
  v_count := public.initialize_inquiry_outbox_deliveries(
    '00000000-0000-4000-8000-0000000000b1'::uuid,
    array['email', 'wecom']::text[]
  );
  if v_count <> 0 then
    raise exception 'D.2: re-initialize should return 0 (idempotent), got %', v_count;
  end if;
end $$;

-- D.3: initialize with zero providers marks parent as dead_letter.
insert into public.inquiry_outbox (
  id, inquiry_id, event_type, status, attempts, max_attempts, next_retry_at
) values (
  '00000000-0000-4000-8000-0000000000b2',
  '00000000-0000-4000-8000-0000000000b0',
  'inquiry_created', 'pending', 0, 5, now()
)
on conflict (id) do nothing;

do $$
declare
  v_count integer;
  v_status text;
  v_error_code text;
begin
  v_count := public.initialize_inquiry_outbox_deliveries(
    '00000000-0000-4000-8000-0000000000b2'::uuid,
    array[]::text[]
  );
  if v_count <> 0 then
    raise exception 'D.3: initialize with empty providers should return 0, got %', v_count;
  end if;

  select status, last_error_code into v_status, v_error_code
    from public.inquiry_outbox
    where id = '00000000-0000-4000-8000-0000000000b2';
  if v_status <> 'dead_letter' then
    raise exception 'D.3: parent should be dead_letter, got %', v_status;
  end if;
  if v_error_code <> 'NOTIFICATION_NOT_CONFIGURED' then
    raise exception 'D.3: last_error_code should be NOTIFICATION_NOT_CONFIGURED, got %', v_error_code;
  end if;
end $$;

-- D.4: initialize rejects unwhitelisted providers (silently skipped).
insert into public.inquiry_outbox (
  id, inquiry_id, event_type, status, attempts, max_attempts, next_retry_at
) values (
  '00000000-0000-4000-8000-0000000000b3',
  '00000000-0000-4000-8000-0000000000b0',
  'inquiry_created', 'pending', 0, 5, now()
)
on conflict (id) do nothing;

do $$
declare
  v_count integer;
  v_delivery_count integer;
begin
  -- 'sms' is not whitelisted; only 'email' should be initialized.
  v_count := public.initialize_inquiry_outbox_deliveries(
    '00000000-0000-4000-8000-0000000000b3'::uuid,
    array['email', 'sms']::text[]
  );
  if v_count <> 1 then
    raise exception 'D.4: initialize should create 1 delivery (email only), got %', v_count;
  end if;

  select count(*) into v_delivery_count from public.inquiry_outbox_deliveries
    where outbox_event_id = '00000000-0000-4000-8000-0000000000b3';
  if v_delivery_count <> 1 then
    raise exception 'D.4: should have 1 delivery row, got %', v_delivery_count;
  end if;
end $$;

-- D.5: find_uninitialized_outbox_events returns only uninitialized events.
-- (b1, b2, b3 are now initialized; b4 is not.)
insert into public.inquiry_outbox (
  id, inquiry_id, event_type, status, attempts, max_attempts, next_retry_at
) values (
  '00000000-0000-4000-8000-0000000000b4',
  '00000000-0000-4000-8000-0000000000b0',
  'inquiry_created', 'pending', 0, 5, now()
)
on conflict (id) do nothing;

do $$
declare
  v_ids uuid[];
  v_count integer;
begin
  v_ids := public.find_uninitialized_outbox_events(100);
  v_count := coalesce(array_length(v_ids, 1), 0);
  -- b4 should be in the list; b1, b2, b3 should NOT.
  if not ('00000000-0000-4000-8000-0000000000b4' = any(v_ids)) then
    raise exception 'D.5: b4 should be in uninitialized list';
  end if;
  if ('00000000-0000-4000-8000-0000000000b1' = any(v_ids)) then
    raise exception 'D.5: b1 should NOT be in uninitialized list (already initialized)';
  end if;
end $$;

-- D.6: claim returns rows with attempts and max_attempts fields.
-- Reset b3's delivery row to pending (it was initialized with email provider).
update public.inquiry_outbox_deliveries
  set status = 'pending', attempts = 0, max_attempts = 5,
      next_retry_at = now(),
      lock_token = null, locked_at = null, processing_started_at = null
  where outbox_event_id = '00000000-0000-4000-8000-0000000000b3';

do $$
declare
  v_claimed jsonb;
  v_row jsonb;
  v_count integer;
begin
  v_claimed := public.claim_inquiry_outbox_deliveries(10, 300);
  v_count := coalesce(jsonb_array_length(v_claimed), 0);
  if v_count = 0 then
    raise exception 'D.6: should claim at least 1 delivery';
  end if;
  v_row := v_claimed->0;
  if (v_row ? 'attempts') = false then
    raise exception 'D.6: claimed row must include attempts field';
  end if;
  if (v_row ? 'max_attempts') = false then
    raise exception 'D.6: claimed row must include max_attempts field';
  end if;
  if (v_row ? 'lock_token') = false then
    raise exception 'D.6: claimed row must include lock_token field';
  end if;
  if (v_row ? 'outbox_event_id') = false then
    raise exception 'D.6: claimed row must include outbox_event_id field';
  end if;
end $$;

-- D.7: claim skips rows with attempts >= max_attempts.
update public.inquiry_outbox_deliveries
  set status = 'retry', attempts = 5, max_attempts = 5,
      next_retry_at = now(),
      lock_token = null, locked_at = null, processing_started_at = null
  where outbox_event_id = '00000000-0000-4000-8000-0000000000b3';

do $$
declare
  v_claimed jsonb;
  v_count integer;
begin
  v_claimed := public.claim_inquiry_outbox_deliveries(10, 300);
  -- Filter to only b3's deliveries (b3 was reset to retry with attempts=5).
  v_count := coalesce(
    (select count(*) from jsonb_array_elements(v_claimed) where value->>'outbox_event_id' = '00000000-0000-4000-8000-0000000000b3'),
    0
  );
  if v_count <> 0 then
    raise exception 'D.7: should NOT claim delivery with attempts >= max_attempts';
  end if;
end $$;

-- D.8: claim re-claims stale 'claimed' rows after timeout.
update public.inquiry_outbox_deliveries
  set status = 'claimed',
      attempts = 1, max_attempts = 5,
      processing_started_at = now() - interval '1 hour',
      lock_token = '00000000-0000-4000-8000-0000000000c1',
      locked_at = now() - interval '1 hour',
      next_retry_at = now()
  where outbox_event_id = '00000000-0000-4000-8000-0000000000b3';

do $$
declare
  v_claimed jsonb;
  v_count integer;
  v_new_token text;
begin
  v_claimed := public.claim_inquiry_outbox_deliveries(10, 300);
  v_count := coalesce(
    (select count(*) from jsonb_array_elements(v_claimed) where value->>'outbox_event_id' = '00000000-0000-4000-8000-0000000000b3'),
    0
  );
  if v_count <> 1 then
    raise exception 'D.8: should re-claim stale claimed delivery, got % rows', v_count;
  end if;
  v_new_token := (
    select value->>'lock_token' from jsonb_array_elements(v_claimed)
      where value->>'outbox_event_id' = '00000000-0000-4000-8000-0000000000b3'
  );
  if v_new_token is null or v_new_token = '00000000-0000-4000-8000-0000000000c1' then
    raise exception 'D.8: re-claim must issue a fresh lock_token';
  end if;
end $$;

-- D.9: claim does NOT re-claim fresh 'claimed' rows.
update public.inquiry_outbox_deliveries
  set status = 'claimed',
      attempts = 1, max_attempts = 5,
      processing_started_at = now() - interval '10 seconds',
      lock_token = '00000000-0000-4000-8000-0000000000c2',
      locked_at = now(),
      next_retry_at = now()
  where outbox_event_id = '00000000-0000-4000-8000-0000000000b3';

do $$
declare
  v_claimed jsonb;
  v_count integer;
begin
  v_claimed := public.claim_inquiry_outbox_deliveries(10, 300);
  v_count := coalesce(
    (select count(*) from jsonb_array_elements(v_claimed) where value->>'outbox_event_id' = '00000000-0000-4000-8000-0000000000b3'),
    0
  );
  if v_count <> 0 then
    raise exception 'D.9: should NOT re-claim fresh claimed delivery';
  end if;
end $$;

-- D.10: mark_delivery_sent with correct token succeeds and clears lock fields.
update public.inquiry_outbox_deliveries
  set status = 'claimed',
      attempts = 1, max_attempts = 5,
      processing_started_at = now(),
      lock_token = '00000000-0000-4000-8000-0000000000c3',
      locked_at = now(),
      next_retry_at = now(),
      sent_at = null
  where outbox_event_id = '00000000-0000-4000-8000-0000000000b3';

do $$
declare
  v_ok boolean;
  v_lock_token uuid;
  v_locked_at timestamptz;
  v_processing_started_at timestamptz;
  v_status text;
  v_delivery_id uuid;
begin
  select id into v_delivery_id from public.inquiry_outbox_deliveries
    where outbox_event_id = '00000000-0000-4000-8000-0000000000b3'
    limit 1;

  v_ok := public.mark_delivery_sent(
    v_delivery_id,
    '00000000-0000-4000-8000-0000000000c3'::uuid,
    'resend-msg-id-test'
  );
  if not v_ok then
    raise exception 'D.10: mark_delivery_sent with correct token should return true';
  end if;

  select lock_token, locked_at, processing_started_at, status
    into v_lock_token, v_locked_at, v_processing_started_at, v_status
    from public.inquiry_outbox_deliveries
    where id = v_delivery_id;

  if v_status <> 'sent' then
    raise exception 'D.10: status should be sent, got %', v_status;
  end if;
  if v_lock_token is not null then
    raise exception 'D.10: lock_token must be null after sent';
  end if;
  if v_locked_at is not null then
    raise exception 'D.10: locked_at must be null after sent';
  end if;
  if v_processing_started_at is not null then
    raise exception 'D.10: processing_started_at must be null after sent';
  end if;
end $$;

-- D.11: mark_delivery_sent with wrong token returns false.
update public.inquiry_outbox_deliveries
  set status = 'claimed',
      attempts = 1, max_attempts = 5,
      processing_started_at = now(),
      lock_token = '00000000-0000-4000-8000-0000000000c4',
      locked_at = now(),
      next_retry_at = now(),
      sent_at = null
  where outbox_event_id = '00000000-0000-4000-8000-0000000000b3';

do $$
declare
  v_ok boolean;
  v_delivery_id uuid;
begin
  select id into v_delivery_id from public.inquiry_outbox_deliveries
    where outbox_event_id = '00000000-0000-4000-8000-0000000000b3'
    limit 1;

  v_ok := public.mark_delivery_sent(
    v_delivery_id,
    '00000000-0000-4000-8000-0000000000dd'::uuid,  -- WRONG token
    null
  );
  if v_ok then
    raise exception 'D.11: mark_delivery_sent with wrong token must return false';
  end if;
end $$;

-- D.12: mark_delivery_sent marks parent as 'sent' only when ALL deliveries sent.
-- Setup: parent b5 with two deliveries (email + wecom).
-- Mark email sent -> parent should remain 'processing'.
-- Mark wecom sent -> parent should transition to 'sent'.
insert into public.inquiry_outbox (
  id, inquiry_id, event_type, status, attempts, max_attempts, next_retry_at
) values (
  '00000000-0000-4000-8000-0000000000b5',
  '00000000-0000-4000-8000-0000000000b0',
  'inquiry_created', 'processing', 0, 5, now()
)
on conflict (id) do nothing;

insert into public.inquiry_outbox_deliveries
  (id, outbox_event_id, provider, status, attempts, max_attempts, next_retry_at, lock_token, processing_started_at, locked_at)
values
  ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000b5', 'email', 'claimed', 1, 5, now(), '00000000-0000-4000-8000-0000000000e1', now(), now()),
  ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000b5', 'wecom', 'claimed', 1, 5, now(), '00000000-0000-4000-8000-0000000000e2', now(), now())
on conflict (outbox_event_id, provider) do nothing;

do $$
declare
  v_ok boolean;
  v_parent_status text;
begin
  -- Mark email sent. Parent should remain 'processing' (wecom still pending).
  v_ok := public.mark_delivery_sent(
    '00000000-0000-4000-8000-0000000000d1'::uuid,
    '00000000-0000-4000-8000-0000000000e1'::uuid,
    're_email_1'
  );
  if not v_ok then
    raise exception 'D.12: first mark_delivery_sent should succeed';
  end if;

  select status into v_parent_status from public.inquiry_outbox
    where id = '00000000-0000-4000-8000-0000000000b5';
  if v_parent_status <> 'processing' then
    raise exception 'D.12: parent should remain processing after first sent, got %', v_parent_status;
  end if;

  -- Mark wecom sent. Parent should transition to 'sent'.
  v_ok := public.mark_delivery_sent(
    '00000000-0000-4000-8000-0000000000d2'::uuid,
    '00000000-0000-4000-8000-0000000000e2'::uuid,
    null
  );
  if not v_ok then
    raise exception 'D.12: second mark_delivery_sent should succeed';
  end if;

  select status into v_parent_status from public.inquiry_outbox
    where id = '00000000-0000-4000-8000-0000000000b5';
  if v_parent_status <> 'sent' then
    raise exception 'D.12: parent should be sent after all deliveries sent, got %', v_parent_status;
  end if;
end $$;

-- D.13: fail_delivery_event with force_dead_letter forces dead_letter.
insert into public.inquiry_outbox (
  id, inquiry_id, event_type, status, attempts, max_attempts, next_retry_at
) values (
  '00000000-0000-4000-8000-0000000000b6',
  '00000000-0000-4000-8000-0000000000b0',
  'inquiry_created', 'processing', 0, 5, now()
)
on conflict (id) do nothing;

insert into public.inquiry_outbox_deliveries
  (id, outbox_event_id, provider, status, attempts, max_attempts, next_retry_at, lock_token, processing_started_at, locked_at)
values
  ('00000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000b6', 'email', 'claimed', 1, 5, now(), '00000000-0000-4000-8000-0000000000e3', now(), now())
on conflict (outbox_event_id, provider) do nothing;

do $$
declare
  v_result text;
  v_attempts integer;
  v_status text;
begin
  v_result := public.fail_delivery_event(
    '00000000-0000-4000-8000-0000000000d3'::uuid,
    '00000000-0000-4000-8000-0000000000e3'::uuid,
    'RESEND_409_INVALID',
    true  -- force dead_letter
  );
  if v_result <> 'dead_letter' then
    raise exception 'D.13: force_dead_letter should return dead_letter, got %', v_result;
  end if;

  select attempts, status into v_attempts, v_status
    from public.inquiry_outbox_deliveries
    where id = '00000000-0000-4000-8000-0000000000d3';
  if v_status <> 'dead_letter' then
    raise exception 'D.13: delivery status should be dead_letter, got %', v_status;
  end if;
  if v_attempts <> 2 then
    raise exception 'D.13: attempts should be 2 (1 + 1), got %', v_attempts;
  end if;
end $$;

-- D.14: fail_delivery_event marks parent as dead_letter when any delivery is dead_letter.
do $$
declare
  v_parent_status text;
  v_parent_error text;
begin
  select status, last_error_code into v_parent_status, v_parent_error
    from public.inquiry_outbox
    where id = '00000000-0000-4000-8000-0000000000b6';
  if v_parent_status <> 'dead_letter' then
    raise exception 'D.14: parent should be dead_letter after delivery dead_letter, got %', v_parent_status;
  end if;
end $$;

-- D.15: fail_delivery_event clears lock fields on retry transition.
insert into public.inquiry_outbox (
  id, inquiry_id, event_type, status, attempts, max_attempts, next_retry_at
) values (
  '00000000-0000-4000-8000-0000000000b7',
  '00000000-0000-4000-8000-0000000000b0',
  'inquiry_created', 'processing', 0, 5, now()
)
on conflict (id) do nothing;

insert into public.inquiry_outbox_deliveries
  (id, outbox_event_id, provider, status, attempts, max_attempts, next_retry_at, lock_token, processing_started_at, locked_at)
values
  ('00000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-0000000000b7', 'email', 'claimed', 1, 5, now(), '00000000-0000-4000-8000-0000000000e4', now(), now())
on conflict (outbox_event_id, provider) do nothing;

do $$
declare
  v_result text;
  v_lock_token uuid;
  v_locked_at timestamptz;
  v_processing_started_at timestamptz;
  v_attempts integer;
  v_status text;
begin
  v_result := public.fail_delivery_event(
    '00000000-0000-4000-8000-0000000000d4'::uuid,
    '00000000-0000-4000-8000-0000000000e4'::uuid,
    'NETWORK_TIMEOUT',
    false
  );
  if v_result <> 'retry' then
    raise exception 'D.15: should return retry (attempts=2 < max=5), got %', v_result;
  end if;

  select lock_token, locked_at, processing_started_at, attempts, status
    into v_lock_token, v_locked_at, v_processing_started_at, v_attempts, v_status
    from public.inquiry_outbox_deliveries
    where id = '00000000-0000-4000-8000-0000000000d4';

  if v_attempts <> 2 then
    raise exception 'D.15: attempts should be 2, got %', v_attempts;
  end if;
  if v_status <> 'retry' then
    raise exception 'D.15: status should be retry, got %', v_status;
  end if;
  if v_lock_token is not null then
    raise exception 'D.15: lock_token must be null after retry';
  end if;
  if v_locked_at is not null then
    raise exception 'D.15: locked_at must be null after retry';
  end if;
  if v_processing_started_at is not null then
    raise exception 'D.15: processing_started_at must be null after retry';
  end if;
end $$;

-- D.16: Unconditional unique constraint prevents duplicate (event, provider) rows.
-- Try to insert a second 'email' delivery for the same event — should fail.
do $$
begin
  begin
    insert into public.inquiry_outbox_deliveries
      (outbox_event_id, provider, status, attempts, max_attempts, next_retry_at)
    values
      ('00000000-0000-4000-8000-0000000000b7'::uuid, 'email', 'pending', 0, 5, now());
    raise exception 'D.16: duplicate (event, provider) insert should be rejected';
  exception
    when unique_violation then
      null;
  end;
end $$;

-- D.17: mark_inquiry_outbox_not_configured transitions event to dead_letter.
insert into public.inquiry_outbox (
  id, inquiry_id, event_type, status, attempts, max_attempts, next_retry_at
) values (
  '00000000-0000-4000-8000-0000000000b8',
  '00000000-0000-4000-8000-0000000000b0',
  'inquiry_created', 'processing', 0, 5, now()
)
on conflict (id) do nothing;

do $$
declare
  v_ok boolean;
  v_status text;
  v_error_code text;
begin
  v_ok := public.mark_inquiry_outbox_not_configured(
    '00000000-0000-4000-8000-0000000000b8'::uuid
  );
  if not v_ok then
    raise exception 'D.17: mark_inquiry_outbox_not_configured should return true';
  end if;

  select status, last_error_code into v_status, v_error_code
    from public.inquiry_outbox
    where id = '00000000-0000-4000-8000-0000000000b8';
  if v_status <> 'dead_letter' then
    raise exception 'D.17: status should be dead_letter, got %', v_status;
  end if;
  if v_error_code <> 'NOTIFICATION_NOT_CONFIGURED' then
    raise exception 'D.17: last_error_code should be NOTIFICATION_NOT_CONFIGURED, got %', v_error_code;
  end if;
end $$;

rollback;

-- ============================================================
-- S. Storage lifecycle (storage_cleanup_queue + RPCs)
-- ============================================================

begin;
set local role service_role;

-- Configure the trusted managed storage host. The round-4 strict URL
-- parser (`extract_managed_storage_path_strict`) and the fail-closed
-- `check_storage_object_referenced` both consult
-- `site_settings.managed_storage_host` via `get_managed_storage_host()`,
-- which reads `limit 1` without ORDER BY. The seed file already
-- inserted a site_settings row (id 66666666-...) with
-- managed_storage_host = '' (the column default). Inserting a second
-- row with a different id would NOT reliably be picked up by
-- `limit 1`, so the function would keep returning NULL and
-- `check_storage_object_referenced` would fail-closed (return true)
-- for every path — causing S.3 to fail. The fix is to UPDATE the
-- existing seed row(s) in place.
update public.site_settings
  set managed_storage_host = 'example.supabase.co'
  where managed_storage_host is null or btrim(managed_storage_host) = '';

-- Seed a product to use as reference target for check_storage_object_referenced.
insert into public.categories (id, name_cn, slug, is_active) values
  ('00000000-0000-4000-8000-000000000100', '[CLEANUP TEST] category', 'cleanup-test-cat', true)
on conflict (id) do nothing;

insert into public.products (
  id, category_id, name_cn, slug, is_published, cover_image_url
) values (
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000100',
  '[CLEANUP TEST] product',
  'cleanup-test-product',
  true,
  'https://example.supabase.co/storage/v1/object/public/public-assets/products/test-image-referenced.jpg'
)
on conflict (id) do nothing;

-- S.1: check_storage_object_referenced returns true when path is referenced by products.cover_image_url.
do $$
declare
  v_referenced boolean;
begin
  v_referenced := public.check_storage_object_referenced(
    'public-assets',
    'products/test-image-referenced.jpg'
  );
  if not v_referenced then
    raise exception 'S.1: path referenced by products.cover_image_url should return true';
  end if;
end $$;

-- S.2: check_storage_object_referenced returns true when path is referenced by product_assets.file_url.
insert into public.product_assets (
  id, product_id, asset_type, title_cn, file_url, is_published, access_level, authorization_status
) values (
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000101',
  'catalog',
  '[CLEANUP TEST] asset',
  'https://example.supabase.co/storage/v1/object/public/public-assets/catalogs/test-catalog-referenced.pdf',
  true,
  'public',
  'confirmed'
)
on conflict (id) do nothing;

do $$
declare
  v_referenced boolean;
begin
  v_referenced := public.check_storage_object_referenced(
    'public-assets',
    'catalogs/test-catalog-referenced.pdf'
  );
  if not v_referenced then
    raise exception 'S.2: path referenced by product_assets.file_url should return true';
  end if;
end $$;

-- S.3: check_storage_object_referenced returns false for unreferenced path.
do $$
declare
  v_referenced boolean;
begin
  v_referenced := public.check_storage_object_referenced(
    'public-assets',
    'products/unreferenced-image-not-in-db-' || gen_random_uuid()::text || '.jpg'
  );
  if v_referenced then
    raise exception 'S.3: unreferenced path should return false';
  end if;
end $$;

-- S.4: check_storage_object_referenced refuses delete (returns true) on empty/invalid path.
do $$
declare
  v_referenced boolean;
begin
  v_referenced := public.check_storage_object_referenced('public-assets', '');
  if not v_referenced then
    raise exception 'S.4: empty path should return true (refuse delete)';
  end if;
end $$;

-- S.5: enqueue_storage_cleanup inserts a pending row.
do $$
declare
  v_id uuid;
  v_count integer;
begin
  v_id := public.enqueue_storage_cleanup(
    'public-assets',
    'products/cleanup-pending-' || gen_random_uuid()::text || '.jpg',
    'form_cancelled',
    'product_image',
    null
  );
  if v_id is null then
    raise exception 'S.5: enqueue should return a non-null id for new path';
  end if;

  select count(*) into v_count from public.storage_cleanup_queue
    where id = v_id and status = 'pending';
  if v_count <> 1 then
    raise exception 'S.5: pending row should exist';
  end if;
end $$;

-- S.6: enqueue_storage_cleanup is idempotent (no duplicate pending rows).
do $$
declare
  v_id1 uuid;
  v_id2 uuid;
  v_count integer;
begin
  v_id1 := public.enqueue_storage_cleanup(
    'public-assets',
    'products/cleanup-idempotent-test.jpg',
    'replaced',
    'product_image',
    null
  );
  v_id2 := public.enqueue_storage_cleanup(
    'public-assets',
    'products/cleanup-idempotent-test.jpg',
    'replaced',
    'product_image',
    null
  );
  if v_id2 is not null then
    raise exception 'S.6: idempotent re-enqueue should return null';
  end if;

  select count(*) into v_count from public.storage_cleanup_queue
    where bucket = 'public-assets' and object_path = 'products/cleanup-idempotent-test.jpg'
      and status in ('pending', 'claimed', 'retry');
  if v_count <> 1 then
    raise exception 'S.6: should have exactly 1 active row, got %', v_count;
  end if;
end $$;

-- S.7: enqueue_storage_cleanup rejects invalid bucket.
do $$
begin
  begin
    perform public.enqueue_storage_cleanup(
      'evil-bucket',
      'products/test.jpg',
      'form_cancelled',
      null,
      null
    );
    raise exception 'S.7: invalid bucket should be rejected';
  exception
    when check_violation then
      null;
  end;
end $$;

-- S.8: claim_storage_cleanup claims pending rows with lock_token.
do $$
declare
  v_claimed jsonb;
  v_count integer;
  v_lock_token text;
begin
  v_claimed := public.claim_storage_cleanup(10, 300);
  v_count := coalesce(jsonb_array_length(v_claimed), 0);
  if v_count = 0 then
    raise exception 'S.8: should claim at least 1 cleanup row';
  end if;
  v_lock_token := v_claimed->0->>'lock_token';
  if v_lock_token is null then
    raise exception 'S.8: claimed row must include lock_token';
  end if;
end $$;

-- S.9: claim_storage_cleanup re-claims stale claimed rows.
update public.storage_cleanup_queue
  set status = 'claimed',
      lock_token = '00000000-0000-4000-8000-0000000000f1',
      locked_at = now() - interval '1 hour',
      next_retry_at = now()
  where object_path = 'products/cleanup-idempotent-test.jpg';

do $$
declare
  v_claimed jsonb;
  v_count integer;
  v_new_token text;
begin
  v_claimed := public.claim_storage_cleanup(10, 300);
  v_count := coalesce(
    (select count(*) from jsonb_array_elements(v_claimed)
      where value->>'object_path' = 'products/cleanup-idempotent-test.jpg'),
    0
  );
  if v_count <> 1 then
    raise exception 'S.9: should re-claim stale row, got % rows', v_count;
  end if;
  v_new_token := (
    select value->>'lock_token' from jsonb_array_elements(v_claimed)
      where value->>'object_path' = 'products/cleanup-idempotent-test.jpg'
  );
  if v_new_token is null or v_new_token = '00000000-0000-4000-8000-0000000000f1' then
    raise exception 'S.9: re-claim must issue fresh lock_token';
  end if;
end $$;

-- S.10: complete_storage_cleanup with success marks completed and clears lock fields.
do $$
declare
  v_cleanup_id uuid;
  v_lock_token uuid;
  v_result text;
  v_status text;
  v_lock_after uuid;
begin
  -- Pick the just-claimed row.
  select id, lock_token into v_cleanup_id, v_lock_token
    from public.storage_cleanup_queue
    where object_path = 'products/cleanup-idempotent-test.jpg'
      and status = 'claimed'
    limit 1;

  v_result := public.complete_storage_cleanup(
    v_cleanup_id,
    v_lock_token,
    true,
    null
  );
  if v_result <> 'completed' then
    raise exception 'S.10: should return completed, got %', v_result;
  end if;

  select status, lock_token into v_status, v_lock_after
    from public.storage_cleanup_queue
    where id = v_cleanup_id;
  if v_status <> 'completed' then
    raise exception 'S.10: status should be completed, got %', v_status;
  end if;
  if v_lock_after is not null then
    raise exception 'S.10: lock_token must be null after completed';
  end if;
end $$;

-- S.11: complete_storage_cleanup with failure transitions to retry with backoff.
do $$
declare
  v_id uuid;
  v_result text;
  v_status text;
  v_attempts integer;
  v_next_retry_at timestamptz;
  v_lock_after uuid;
begin
  -- Enqueue a fresh row.
  v_id := public.enqueue_storage_cleanup(
    'public-assets',
    'products/cleanup-retry-test.jpg',
    'row_deleted',
    null,
    null
  );
  -- Claim it.
  perform public.claim_storage_cleanup(10, 300);
  -- Get the lock_token.
  select lock_token into v_lock_after from public.storage_cleanup_queue
    where id = v_id and status = 'claimed';
  if v_lock_after is null then
    raise exception 'S.11: setup failed — row not claimed';
  end if;

  v_result := public.complete_storage_cleanup(v_id, v_lock_after, false, 'STORAGE_DELETE_FAILED');
  if v_result <> 'retry' then
    raise exception 'S.11: should return retry, got %', v_result;
  end if;

  select status, attempts, next_retry_at, lock_token
    into v_status, v_attempts, v_next_retry_at, v_lock_after
    from public.storage_cleanup_queue
    where id = v_id;
  if v_status <> 'retry' then
    raise exception 'S.11: status should be retry, got %', v_status;
  end if;
  if v_attempts <> 1 then
    raise exception 'S.11: attempts should be 1, got %', v_attempts;
  end if;
  if v_next_retry_at is null or v_next_retry_at <= now() then
    raise exception 'S.11: next_retry_at should be in the future';
  end if;
  if v_lock_after is not null then
    raise exception 'S.11: lock_token must be null after retry';
  end if;
end $$;

-- S.12: complete_storage_cleanup transitions to dead_letter after max_attempts.
do $$
declare
  v_id uuid;
  v_lock_token uuid;
  v_result text;
  v_status text;
  v_attempts integer;
begin
  v_id := public.enqueue_storage_cleanup(
    'public-assets',
    'products/cleanup-dead-letter-test.jpg',
    'row_deleted',
    null,
    null
  );
  -- Set attempts to max-1, claim it.
  update public.storage_cleanup_queue
    set status = 'claimed',
        attempts = 4,
        max_attempts = 5,
        lock_token = '00000000-0000-4000-8000-0000000000f2',
        locked_at = now(),
        next_retry_at = now()
    where id = v_id;

  v_result := public.complete_storage_cleanup(
    v_id,
    '00000000-0000-4000-8000-0000000000f2'::uuid,
    false,
    'STORAGE_DELETE_FAILED'
  );
  if v_result <> 'dead_letter' then
    raise exception 'S.12: should return dead_letter, got %', v_result;
  end if;

  select status, attempts into v_status, v_attempts
    from public.storage_cleanup_queue
    where id = v_id;
  if v_status <> 'dead_letter' then
    raise exception 'S.12: status should be dead_letter, got %', v_status;
  end if;
  if v_attempts <> 5 then
    raise exception 'S.12: attempts should be 5 (max), got %', v_attempts;
  end if;
end $$;

-- S.13: complete_storage_cleanup with wrong token returns NOT_FOUND_OR_TOKEN_MISMATCH.
do $$
declare
  v_result text;
begin
  v_result := public.complete_storage_cleanup(
    '00000000-0000-4000-8000-000000000099'::uuid,  -- doesn't exist
    '00000000-0000-4000-8000-0000000000aa'::uuid,
    true,
    null
  );
  if v_result <> 'NOT_FOUND_OR_TOKEN_MISMATCH' then
    raise exception 'S.13: should return NOT_FOUND_OR_TOKEN_MISMATCH, got %', v_result;
  end if;
end $$;

-- S.14: RLS — anon CANNOT read storage_cleanup_queue.
-- The table REVOKEs ALL from anon/authenticated, so SELECT raises
-- insufficient_privilege rather than returning an empty set. We treat
-- both the raised error and an empty result as acceptable proofs of
-- denial; any other outcome (rows returned without error) is a failure.
set local role anon;
do $$
declare
  v_count integer;
begin
  begin
    select count(*) into v_count from public.storage_cleanup_queue;
  exception
    when insufficient_privilege or others then
      -- Expected: anon has no SELECT privilege on storage_cleanup_queue.
      null;
  end;
  if v_count is not null and v_count > 0 then
    raise exception 'S.14: anon must NOT be able to read storage_cleanup_queue';
  end if;
end $$;

-- S.15: RLS — authenticated CANNOT read storage_cleanup_queue.
set local role authenticated;
do $$
declare
  v_count integer;
begin
  begin
    select count(*) into v_count from public.storage_cleanup_queue;
  exception
    when insufficient_privilege or others then
      -- Expected: authenticated has no SELECT privilege on storage_cleanup_queue.
      null;
  end;
  if v_count is not null and v_count > 0 then
    raise exception 'S.15: authenticated must NOT be able to read storage_cleanup_queue';
  end if;
end $$;

rollback;

-- ============================================================
-- P. publish_catalog_asset RPC
-- ============================================================

begin;
set local role service_role;

-- Seed category + product + assets for publish tests.
insert into public.categories (id, name_cn, slug, is_active) values
  ('00000000-0000-4000-8000-000000000200', '[PUBLISH TEST] category', 'publish-test-cat', true)
on conflict (id) do nothing;

insert into public.products (
  id, category_id, name_cn, slug, is_published
) values (
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000200',
  '[PUBLISH TEST] product',
  'publish-test-product',
  true
)
on conflict (id) do nothing;

-- P.1: Rejects asset with access_level != 'public'.
insert into public.product_assets (
  id, product_id, asset_type, title_cn, file_url, is_published, access_level, authorization_status
) values (
  '00000000-0000-4000-8000-000000000210',
  '00000000-0000-4000-8000-000000000201',
  'catalog',
  '[PUBLISH TEST] private asset',
  '/private-assets/catalogs/private.pdf',
  true,
  'private',     -- NOT public
  'confirmed'
)
on conflict (id) do nothing;

do $$
begin
  begin
    perform public.publish_catalog_asset(
      '00000000-0000-4000-8000-000000000210'::uuid,
      '/public-assets/catalogs/published.pdf',
      null,
      null,
      null,
      null
    );
    raise exception 'P.1: private access_level must be rejected';
  exception
    when sqlstate '23001' then
      null;
  end;
end $$;

-- P.2: Rejects asset with authorization_status != 'confirmed'.
insert into public.product_assets (
  id, product_id, asset_type, title_cn, file_url, is_published, access_level, authorization_status
) values (
  '00000000-0000-4000-8000-000000000211',
  '00000000-0000-4000-8000-000000000201',
  'catalog',
  '[PUBLISH TEST] pending asset',
  '/private-assets/catalogs/pending.pdf',
  true,
  'public',
  'pending'      -- NOT confirmed
)
on conflict (id) do nothing;

do $$
begin
  begin
    perform public.publish_catalog_asset(
      '00000000-0000-4000-8000-000000000211'::uuid,
      '/public-assets/catalogs/published.pdf',
      null,
      null,
      null,
      null
    );
    raise exception 'P.2: pending authorization_status must be rejected';
  exception
    when sqlstate '23001' then
      null;
  end;
end $$;

-- P.3: Rejects asset with is_published = false.
insert into public.product_assets (
  id, product_id, asset_type, title_cn, file_url, is_published, access_level, authorization_status
) values (
  '00000000-0000-4000-8000-000000000212',
  '00000000-0000-4000-8000-000000000201',
  'catalog',
  '[PUBLISH TEST] unpublished asset',
  '/private-assets/catalogs/unpublished.pdf',
  false,         -- NOT published
  'public',
  'confirmed'
)
on conflict (id) do nothing;

do $$
begin
  begin
    perform public.publish_catalog_asset(
      '00000000-0000-4000-8000-000000000212'::uuid,
      '/public-assets/catalogs/published.pdf',
      null,
      null,
      null,
      null
    );
    raise exception 'P.3: unpublished asset must be rejected';
  exception
    when sqlstate '23001' then
      null;
  end;
end $$;

-- P.4: Rejects nonexistent asset id (P0002).
do $$
begin
  begin
    perform public.publish_catalog_asset(
      '00000000-0000-4000-8000-000000000299'::uuid,  -- doesn't exist
      '/public-assets/catalogs/published.pdf',
      null,
      null,
      null,
      null
    );
    raise exception 'P.4: nonexistent asset must raise P0002';
  exception
    when sqlstate 'P0002' then
      null;
  end;
end $$;

-- P.5 + P.6: Succeeds and returns old + new URLs, audit log row inserted.
insert into public.product_assets (
  id, product_id, asset_type, title_cn, file_url, is_published, access_level, authorization_status
) values (
  '00000000-0000-4000-8000-000000000213',
  '00000000-0000-4000-8000-000000000201',
  'catalog',
  '[PUBLISH TEST] publishable asset',
  '/private-assets/catalogs/ready-to-publish.pdf',
  true,
  'public',
  'confirmed'
)
on conflict (id) do nothing;

do $$
declare
  v_result jsonb;
  v_audit_count integer;
  v_new_file_url text;
  v_new_cover_image_url text;
begin
  v_result := public.publish_catalog_asset(
    '00000000-0000-4000-8000-000000000213'::uuid,
    'https://example.supabase.co/storage/v1/object/public/public-assets/catalogs/published.pdf',
    'https://example.supabase.co/storage/v1/object/public/public-assets/catalogs/cover.jpg',
    '00000000-0000-4000-8000-000000000299'::uuid,
    'admin@test.local',
    'admin'
  );

  -- Result must include old + new URLs.
  if v_result->>'old_file_url' <> '/private-assets/catalogs/ready-to-publish.pdf' then
    raise exception 'P.5: old_file_url mismatch: %', v_result->>'old_file_url';
  end if;
  if v_result->>'new_file_url' <> 'https://example.supabase.co/storage/v1/object/public/public-assets/catalogs/published.pdf' then
    raise exception 'P.5: new_file_url mismatch: %', v_result->>'new_file_url';
  end if;
  if v_result->>'new_cover_image_url' <> 'https://example.supabase.co/storage/v1/object/public/public-assets/catalogs/cover.jpg' then
    raise exception 'P.5: new_cover_image_url mismatch: %', v_result->>'new_cover_image_url';
  end if;

  -- The asset's file_url should be updated.
  select file_url into v_new_file_url from public.product_assets
    where id = '00000000-0000-4000-8000-000000000213';
  if v_new_file_url <> 'https://example.supabase.co/storage/v1/object/public/public-assets/catalogs/published.pdf' then
    raise exception 'P.5: asset file_url was not updated: %', v_new_file_url;
  end if;

  -- An audit log row should exist.
  select count(*) into v_audit_count from public.admin_audit_log
    where action = 'catalog_asset.publish'
      and target_id = '00000000-0000-4000-8000-000000000213';
  if v_audit_count <> 1 then
    raise exception 'P.6: audit log row should exist (count=%)', v_audit_count;
  end if;
end $$;

rollback;
