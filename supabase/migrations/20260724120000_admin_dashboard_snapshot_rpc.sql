-- Phase 1: Admin Dashboard snapshot RPC
--
-- Returns the five admin dashboard counts in a single round-trip so the
-- dashboard no longer relies on multiple `{ count: "exact" }` PostgREST
-- queries (which are estimated, leak table structure, and cannot be made
-- atomic).
--
-- Safety contract:
--   * language sql            -> no procedural side effects
--   * stable                  -> read-only, cacheable
--   * security invoker        -> runs with caller privileges (service_role
--                                 bypasses RLS, giving true totals)
--   * set search_path = ''    -> no implicit schema resolution; every table
--                                 is referenced explicitly as public.<table>
--   * revoke from public/anon/authenticated -> only service_role may execute
--   * grant execute to service_role only
--   * no INSERT/UPDATE/DELETE
--   * count(*)::bigint (exact, never estimated)
--   * never returns 0 on error: a SQL error propagates as an RPC error,
--     which the application layer classifies into an explicit failure state
--
-- This migration is additive only. It does not alter any existing table,
-- policy, function, or data. It is safe to run on a populated database.

create or replace function public.get_admin_dashboard_snapshot()
returns table(
  total_products bigint,
  published_products bigint,
  total_certificates bigint,
  total_inquiries bigint,
  unread_inquiries bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    (select count(*)::bigint from public.products) as total_products,
    (select count(*)::bigint from public.products where is_published = true) as published_products,
    (select count(*)::bigint from public.certificates) as total_certificates,
    (select count(*)::bigint from public.inquiries) as total_inquiries,
    (select count(*)::bigint from public.inquiries where is_read = false) as unread_inquiries;
$$;

revoke all on function public.get_admin_dashboard_snapshot()
  from public, anon, authenticated;

grant execute on function public.get_admin_dashboard_snapshot()
  to service_role;
