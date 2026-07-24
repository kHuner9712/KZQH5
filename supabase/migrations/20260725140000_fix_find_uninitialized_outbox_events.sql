-- ============================================================
-- 20260725140000_fix_find_uninitialized_outbox_events.sql
--
-- Problem:
--   `find_uninitialized_outbox_events` (defined in
--   20260725110000) used:
--     select array_agg(id)
--       from public.inquiry_outbox
--       where providers_initialized_at is null
--         and status in ('pending', 'processing', 'retry')
--       order by created_at
--       limit v_safe_limit;
--
--   This is invalid SQL. When an aggregate function like
--   array_agg(id) is used, a top-level ORDER BY may only
--   reference grouped columns or aggregate inputs. PostgreSQL
--   rejects it with:
--     ERROR: column "inquiry_outbox.created_at" must appear in
--     the GROUP BY clause or be used in an aggregate function
--
--   The intent was: pick the N oldest uninitialized events and
--   return their IDs as an array. The LIMIT must apply to the
--   row selection BEFORE aggregation, not after.
--
-- Fix:
--   Rewrite as a subquery so LIMIT applies to row selection,
--   then array_agg the limited set. The subquery ORDER BY
--   created_at is preserved so the array is in chronological
--   order (stable for deterministic test seeds and fair
--   back-pressure in production).
--
--   Recreate the function with the corrected body. The signature
--   is unchanged, so existing callers (outbox-processor.ts) are
--   unaffected.
--
-- Safety:
--   * Idempotent — CREATE OR REPLACE.
--   * No schema change, no GRANT change, no RLS change.
--   * SECURITY INVOKER + SET search_path = '' preserved.
--   * The revoke/grant block is re-issued to match the original
--     migration's posture (defense in depth).
-- ============================================================

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
  select array_agg(id)
    into v_ids
    from (
      select id
        from public.inquiry_outbox
        where providers_initialized_at is null
          and status in ('pending', 'processing', 'retry')
        order by created_at
        limit v_safe_limit
    ) sub;

  return coalesce(v_ids, '{}'::uuid[]);
end;
$$;

revoke all on function public.find_uninitialized_outbox_events(integer)
  from public, anon, authenticated;
grant execute on function public.find_uninitialized_outbox_events(integer)
  to service_role;
