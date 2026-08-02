-- ============================================================
-- KZQ-P1-011-b: Distributed rate limiting via PostgreSQL atomic RPC
-- ------------------------------------------------------------
-- Purpose:
--   Provide a production-grade, multi-instance SHARED rate-limit
--   backend. The existing MemoryRateLimiter is only consistent
--   within a single Node process; on EdgeOne multi-instance
--   deployments the effective limit is N × configured. This
--   migration adds a PostgreSQL-backed fixed-window counter so all
--   instances read/write the same state with atomic increment.
--
-- Semantics:
--   - FIXED WINDOW: window_start = floor(now_epoch / window_seconds)
--     * window_seconds. Requests in the same window share one counter.
--   - ATOMIC: INSERT ... ON CONFLICT DO UPDATE is atomic in
--     PostgreSQL — concurrent increments from multiple instances
--     cannot lose updates (row-level locking).
--   - Keys are opaque caller-supplied strings (already hashed or
--     namespaced by the application, e.g. `ip:<addr>`,
--     `admin:<userId>`, `fallback:global`). No PII is stored.
--
-- Security:
--   - SECURITY INVOKER (caller must have EXECUTE; only service_role
--     is granted).
--   - search_path = '' to prevent object spoofing.
--   - Table has RLS enabled and is NOT directly accessible to
--     anon/authenticated — all access goes through the RPCs.
--   - Only coarse fixed error codes are returned; no SQL detail.
--
-- Rollback boundary:
--   Drop the two functions and the table. Safe — the application
--   falls back to MemoryRateLimiter when the RPC is absent (fail-open
--   per the P1-011-a decision matrix).
-- ============================================================

-- ------------------------------------------------------------
-- Counter table
-- ------------------------------------------------------------
create table if not exists public.rate_limit_counters (
  bucket        text        not null,
  key           text        not null,
  window_start  timestamptz not null,
  count         integer     not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (bucket, key, window_start)
);

-- New tables must have RLS enabled by default (project rule).
alter table public.rate_limit_counters enable row level security;

-- Direct table access is NOT granted to anon/authenticated/public.
-- All access must go through the RPCs below (service_role only).
revoke all on public.rate_limit_counters from public, anon, authenticated;

-- The owner (postgres/service_role) keeps full control; no explicit
-- grant to authenticated. Service_role operates via the RPC grants
-- below.

create index if not exists rate_limit_counters_cleanup_idx
  on public.rate_limit_counters (bucket, window_start);

-- ------------------------------------------------------------
-- rate_limit_check — atomic fixed-window increment
-- ------------------------------------------------------------
-- Returns jsonb:
--   { ok: true,  allowed: true,  remaining: N, retry_after_seconds: 0 }
--   { ok: true,  allowed: false, remaining: 0, retry_after_seconds: S }
--   { ok: false, error: '<fixed-code>' }
--
-- The application MUST treat transport error / null / malformed /
-- ok !== true as failure, and then apply its configured fail-open or
-- fail-closed policy (P1-011-a decision matrix: application-layer
-- exceptions → fail-open, rely on EdgeOne WAF as the floor).
create or replace function public.rate_limit_check(
  p_bucket text,
  p_key text,
  p_max_count integer,
  p_window_seconds integer
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now_epoch bigint := floor(extract(epoch from clock_timestamp()));
  v_window_start_epoch bigint;
  v_window_start timestamptz;
  v_count integer;
  v_retry_after integer;
begin
  -- Input validation (defense-in-depth; application validates too).
  if p_bucket is null or p_bucket = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_bucket');
  end if;
  if p_key is null or p_key = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_key');
  end if;
  if p_max_count is null or p_max_count <= 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_max_count');
  end if;
  if p_window_seconds is null or p_window_seconds <= 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_window_seconds');
  end if;

  -- Fixed-window boundary: floor(epoch / window) * window.
  v_window_start_epoch := floor(v_now_epoch / p_window_seconds) * p_window_seconds;
  v_window_start := to_timestamp(v_window_start_epoch);

  -- Atomic increment: INSERT ... ON CONFLICT DO UPDATE is safe under
  -- concurrency (row lock on the (bucket,key,window_start) tuple).
  insert into public.rate_limit_counters (bucket, key, window_start, count, updated_at)
  values (p_bucket, p_key, v_window_start, 1, clock_timestamp())
  on conflict (bucket, key, window_start)
  do update set
    count = public.rate_limit_counters.count + 1,
    updated_at = clock_timestamp()
  returning count into v_count;

  if v_count > p_max_count then
    -- Seconds until the current fixed window ends (at least 1).
    v_retry_after := greatest(
      1,
      (v_window_start_epoch + p_window_seconds) - v_now_epoch
    );
    return jsonb_build_object(
      'ok', true,
      'allowed', false,
      'remaining', 0,
      'retry_after_seconds', v_retry_after
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'allowed', true,
    'remaining', p_max_count - v_count,
    'retry_after_seconds', 0
  );
end;
$$;

revoke all on function public.rate_limit_check(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.rate_limit_check(text, text, integer, integer)
  to service_role;

-- ------------------------------------------------------------
-- rate_limit_cleanup_expired — bound table growth
-- ------------------------------------------------------------
-- Deletes counters whose window ended more than
-- p_older_than_seconds ago. Returns the number of rows deleted.
--
-- Cleanup is best-effort; the insert path is never blocked by it.
-- A periodic caller (e.g. cron / dispatcher) may invoke this, or the
-- application may call it opportunistically.
create or replace function public.rate_limit_cleanup_expired(
  p_older_than_seconds integer
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_older_than_seconds is null or p_older_than_seconds <= 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_older_than_seconds');
  end if;

  delete from public.rate_limit_counters
  where window_start < clock_timestamp() - make_interval(secs => p_older_than_seconds);

  get diagnostics v_deleted = row_count;

  return jsonb_build_object('ok', true, 'deleted', v_deleted);
end;
$$;

revoke all on function public.rate_limit_cleanup_expired(integer)
  from public, anon, authenticated;
grant execute on function public.rate_limit_cleanup_expired(integer)
  to service_role;
