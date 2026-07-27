-- ============================================================
-- 20260728020000_outbox_orphaned_status_and_health.sql
--
-- Work Package E: Outbox reliability and observability.
--
-- Problem (silent failure / state semantics):
--   When the parent inquiry_outbox row was deleted (FK cascade)
--   OR the inquiry itself was deleted, the processor previously
--   marked the per-provider delivery row as `sent` via
--   `mark_delivery_sent`. That conflated two very different
--   outcomes:
--     * the provider accepted and delivered the message
--     * the delivery's target vanished, so we gave up
--   This inflated `sent` counters and hid the underlying
--   data-integrity issue from operators.
--
-- Solution (forward-only, no enum migration):
--   The `inquiry_outbox_deliveries.status` column is plain text,
--   not a CHECK-constrained enum, so we introduce a new terminal
--   status value `cancelled` for orphaned deliveries without
--   touching the column type. The existing stats queries filter
--   by exact status ('sent' | 'retry' | 'dead_letter'), so adding
--   `cancelled` does not alter their counts.
--
--   This migration:
--     1. Updates mark_delivery_sent so its parent-completion
--        check treats BOTH `sent` AND `cancelled` as terminal
--        (otherwise a parent with one sent + one cancelled would
--        stay in `processing` forever).
--     2. Adds cancel_orphaned_delivery(p_delivery_id, p_lock_token,
--        p_reason) — atomically marks a claimed delivery as
--        `cancelled`, clears lock fields, records the reason in
--        last_error_code, and (when every remaining delivery for
--        the parent is now `sent` or `cancelled`) transitions the
--        parent to `sent` so it does not linger in `processing`.
--     3. Adds get_outbox_health_snapshot() — a coarse-grained,
--        PII-free health snapshot for the internal status route.
--        Returns counts and oldest-row ages only. NEVER returns
--        inquiry ids, lock tokens, provider message ids, or error
--        codes that may carry PII.
--
-- Safety:
--   * Forward-only. No existing migration is modified.
--   * No RLS policy changes. No GRANT to anon/authenticated.
--   * SECURITY INVOKER + SET search_path = '' preserved on every
--     function. service_role retains EXECUTE; anon/authenticated/PUBLIC
--     are explicitly REVOKE'd.
--   * mark_delivery_sent keeps its existing signature — callers
--     (outbox-processor.ts) are unaffected.
-- ============================================================

-- ============================================================
-- A. cancel_orphaned_delivery RPC
-- ============================================================
-- Marks a claimed delivery as `cancelled` because its parent
-- event or inquiry was deleted (FK cascade). The delivery MUST
-- currently be `claimed` and the lock_token MUST match — this
-- prevents a stale Worker from cancelling a delivery that was
-- already re-claimed and sent by a newer Worker.
--
-- When every remaining delivery for the parent is now `sent` or
-- `cancelled`, the parent is transitioned to `sent` so it does
-- not stay in `processing` forever. (We do NOT add a `cancelled`
-- status to the parent — that would break existing stat queries
-- that expect the parent to be one of pending/processing/sent/
-- dead_letter. The parent's `sent_at` records the cancellation
-- time; the delivery rows carry the granular `cancelled` state
-- and the reason in last_error_code for operator review.)
--
-- Returns:
--   'cancelled'                — delivery was successfully cancelled.
--   'NOT_FOUND_OR_TOKEN_MISMATCH' — no row matched (wrong lock_token,
--                                delivery already finalized, or
--                                delivery_id does not exist).
--   'INVALID_PARAMS'           — null input.
create or replace function public.cancel_orphaned_delivery(
  p_delivery_id uuid,
  p_lock_token uuid,
  p_reason text default null
) returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_updated integer;
  v_reason text := coalesce(left(p_reason, 80), 'ORPHANED');
begin
  if p_delivery_id is null or p_lock_token is null then
    return 'INVALID_PARAMS';
  end if;

  update public.inquiry_outbox_deliveries
    set status = 'cancelled',
        sent_at = now(),
        last_error_code = v_reason,
        lock_token = null,
        locked_at = null,
        processing_started_at = null,
        next_retry_at = null,
        updated_at = now()
    where id = p_delivery_id
      and status = 'claimed'
      and lock_token = p_lock_token
    returning outbox_event_id into v_event_id;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return 'NOT_FOUND_OR_TOKEN_MISMATCH';
  end if;

  -- If every delivery for the parent is now in a terminal state
  -- (sent | cancelled), transition the parent to `sent` so it
  -- does not linger in `processing`. This mirrors mark_delivery_sent's
  -- parent-completion logic but treats `cancelled` as terminal too.
  perform 1
    from public.inquiry_outbox_deliveries
    where outbox_event_id = v_event_id
      and status not in ('sent', 'cancelled')
    limit 1;
  if not found then
    update public.inquiry_outbox
      set status = 'sent',
          sent_at = coalesce(sent_at, now()),
          last_error_code = null,
          lock_token = null,
          locked_at = null,
          processing_started_at = null,
          updated_at = now()
      where id = v_event_id
        and status in ('processing', 'pending', 'retry');
  end if;

  return 'cancelled';
end;
$$;

revoke all on function public.cancel_orphaned_delivery(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.cancel_orphaned_delivery(uuid, uuid, text)
  to service_role;

-- ============================================================
-- B. mark_delivery_sent — treat `cancelled` as terminal
-- ============================================================
-- Replace the parent-completion check's `status <> 'sent'` with
-- `status not in ('sent', 'cancelled')` so that a parent with
-- one sent + one cancelled delivery is finalized to `sent`.
-- Signature, return type, and external behavior for the
-- non-orphaned path are unchanged.
-- ============================================================
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

  -- Parent completion: treat both `sent` and `cancelled` as terminal.
  -- A parent with one sent + one cancelled delivery is finalized.
  perform 1
    from public.inquiry_outbox_deliveries
    where outbox_event_id = v_event_id
      and status not in ('sent', 'cancelled')
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

-- ============================================================
-- C. get_outbox_health_snapshot RPC
-- ============================================================
-- Coarse-grained, PII-free health snapshot for the internal
-- status route. Returns counts and oldest-row ages only.
-- NEVER returns inquiry ids, lock tokens, provider message ids,
-- or last_error_code values (which may carry PII).
--
-- Returns a single row with these columns:
--   pending_count          integer
--   retry_count            integer
--   claimed_count          integer
--   sent_count             integer
--   dead_letter_count      integer
--   cancelled_count        integer
--   oldest_pending_age_seconds    double precision (null if none)
--   oldest_claimed_age_seconds    double precision (null if none)
--   oldest_dead_letter_age_seconds double precision (null if none)
--   last_sent_at           timestamptz (null if none ever sent)
--   last_failed_at         timestamptz (null if none ever failed)
--                          (last_failed_at = max(updated_at) where
--                           status in ('retry','dead_letter'))
--   evaluated_at           timestamptz (now() at evaluation)
-- ============================================================
create or replace function public.get_outbox_health_snapshot()
returns table(
  pending_count integer,
  retry_count integer,
  claimed_count integer,
  sent_count integer,
  dead_letter_count integer,
  cancelled_count integer,
  oldest_pending_age_seconds double precision,
  oldest_claimed_age_seconds double precision,
  oldest_dead_letter_age_seconds double precision,
  last_sent_at timestamptz,
  last_failed_at timestamptz,
  evaluated_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_oldest_pending timestamptz;
  v_oldest_claimed timestamptz;
  v_oldest_dead_letter timestamptz;
  v_last_sent timestamptz;
  v_last_failed timestamptz;
begin
  -- Per-delivery-row counts (NOT per-parent-event). The per-delivery
  -- view is the operationally useful one: it tells the operator how
  -- much actual provider work is pending / claimed / failed.
  return query
  select
    (select count(*)::integer from public.inquiry_outbox_deliveries where status = 'pending'),
    (select count(*)::integer from public.inquiry_outbox_deliveries where status = 'retry'),
    (select count(*)::integer from public.inquiry_outbox_deliveries where status = 'claimed'),
    (select count(*)::integer from public.inquiry_outbox_deliveries where status = 'sent'),
    (select count(*)::integer from public.inquiry_outbox_deliveries where status = 'dead_letter'),
    (select count(*)::integer from public.inquiry_outbox_deliveries where status = 'cancelled'),
    -- Ages: extract epoch from the difference. NULL when no rows.
    coalesce(
      (select extract(epoch from (v_now - min(created_at)))::double precision
         from public.inquiry_outbox_deliveries where status = 'pending'),
      null::double precision
    ),
    coalesce(
      (select extract(epoch from (v_now - min(processing_started_at)))::double precision
         from public.inquiry_outbox_deliveries where status = 'claimed'
           and processing_started_at is not null),
      null::double precision
    ),
    coalesce(
      (select extract(epoch from (v_now - min(updated_at)))::double precision
         from public.inquiry_outbox_deliveries where status = 'dead_letter'),
      null::double precision
    ),
    (select max(sent_at) from public.inquiry_outbox_deliveries where sent_at is not null),
    (select max(updated_at) from public.inquiry_outbox_deliveries
       where status in ('retry', 'dead_letter')),
    v_now;
end;
$$;

revoke all on function public.get_outbox_health_snapshot()
  from public, anon, authenticated;
grant execute on function public.get_outbox_health_snapshot()
  to service_role;

-- ============================================================
-- D. Comment updates (documentation only, no behavior change)
-- ============================================================
comment on column public.inquiry_outbox_deliveries.status is
  'Delivery lifecycle state. One of: pending | claimed | sent | retry | dead_letter | cancelled. '
  '`cancelled` is a terminal state for deliveries whose parent event or inquiry was deleted '
  '(FK cascade) before the provider could be invoked. It is NOT counted as `sent`.';
