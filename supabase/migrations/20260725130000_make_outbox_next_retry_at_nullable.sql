-- ============================================================
-- 20260725130000_make_outbox_next_retry_at_nullable.sql
--
-- Problem:
--   Both `inquiry_outbox` and `inquiry_outbox_deliveries` define
--     next_retry_at timestamptz not null default now()
--   but the SECURITY INVOKER functions that transition rows to
--   terminal states set `next_retry_at = null`:
--
--     * `fail_inquiry_outbox_event` (20260725100000) sets
--       next_retry_at = null when status -> 'dead_letter'
--     * `fail_delivery_event` (20260725110000) sets
--       next_retry_at = null on the delivery row when
--       status -> 'dead_letter', AND on the parent
--       inquiry_outbox row when cascading dead_letter.
--
--   The tests assert this nullness:
--     * storage_rls_outbox_rpc.sql C.11:
--         "next_retry_at must be null for dead_letter"
--     * per_provider_delivery_storage_lifecycle.sql D.7/D.8:
--         dead_letter delivery rows have next_retry_at = null
--
--   The schema and the functions/tests disagree. The functions
--   and tests are correct: a terminal-state row (dead_letter or
--   sent) has no "next retry" — NULL is the semantically correct
--   value, and every claim query filters with
--   `next_retry_at <= now()`, which excludes NULLs.
--
-- Fix:
--   Drop the NOT NULL constraint on next_retry_at for both
--   tables. The DEFAULT now() is preserved so new rows still
--   get a sensible value; only explicit NULL writes (terminal
--   state transitions) are now permitted.
--
-- Safety:
--   * Idempotent — uses `if exists` guard via DO block.
--   * No data migration — existing rows all have non-null
--     values, and the constraint drop does not rewrite the
--     table.
--   * No application code change — the functions already write
--     NULL; they were just failing at runtime.
--   * Backward compatible — any code that reads next_retry_at
--     must already handle NULL (terminal states existed before
--     this fix, they just couldn't be persisted).
--   * Indexes remain valid — the partial index
--     `where status in ('pending', 'retry')` is unaffected
--     because those rows always have non-null next_retry_at.
-- ============================================================

do $$
begin
  -- inquiry_outbox
  if exists (
    select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'inquiry_outbox'
        and column_name = 'next_retry_at'
        and is_nullable = 'NO'
  ) then
    alter table public.inquiry_outbox
      alter column next_retry_at drop not null;
  end if;

  -- inquiry_outbox_deliveries
  if exists (
    select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'inquiry_outbox_deliveries'
        and column_name = 'next_retry_at'
        and is_nullable = 'NO'
  ) then
    alter table public.inquiry_outbox_deliveries
      alter column next_retry_at drop not null;
  end if;
end;
$$;
