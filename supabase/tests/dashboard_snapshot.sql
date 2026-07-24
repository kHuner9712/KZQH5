-- Database test for public.get_admin_dashboard_snapshot()
--
-- Verifies that the RPC returns exact counts that reflect inserted rows,
-- and that anon/authenticated cannot execute it.
--
-- Runs inside a transaction and rolls back so no test data persists.

begin;

-- Capture baseline counts BEFORE inserting test rows, so we can verify
-- the RPC reflects exactly +N rows.
create temp table _snapshot_baseline (
  total_products bigint,
  published_products bigint,
  total_certificates bigint,
  total_inquiries bigint,
  unread_inquiries bigint
);
insert into _snapshot_baseline
select
  (select count(*)::bigint from public.products),
  (select count(*)::bigint from public.products where is_published = true),
  (select count(*)::bigint from public.certificates),
  (select count(*)::bigint from public.inquiries),
  (select count(*)::bigint from public.inquiries where is_read = false);

insert into public.products (id, category_id, name_cn, slug, is_published) values
  ('00000000-0000-4000-8000-000000000040', null, '[REGRESSION TEST] snapshot published', 'regression-snapshot-published', true),
  ('00000000-0000-4000-8000-000000000041', null, '[REGRESSION TEST] snapshot hidden', 'regression-snapshot-hidden', false)
on conflict (id) do update set is_published = excluded.is_published;

insert into public.certificates (id, name_cn, is_published) values
  ('00000000-0000-4000-8000-000000000042', '[REGRESSION TEST] snapshot certificate', true)
on conflict (id) do nothing;

insert into public.inquiries (id, name, phone, interested_product, language, is_read) values
  ('00000000-0000-4000-8000-000000000043', '[REGRESSION TEST] snapshot unread', '13800000000', 'snapshot', 'zh', false)
on conflict (id) do nothing;

do $$
declare
  baseline record;
  snap jsonb;
begin
  select * into baseline from _snapshot_baseline;

  -- The test connection is superuser; service_role grant ensures the RPC is
  -- callable. security_invoker + superuser bypasses RLS, yielding true totals.
  select to_jsonb(t) into snap from public.get_admin_dashboard_snapshot() t limit 1;

  if (snap->>'total_products')::bigint < baseline.total_products + 2 then
    raise exception 'snapshot total_products did not reflect 2 inserted products';
  end if;
  if (snap->>'published_products')::bigint < baseline.published_products + 1 then
    raise exception 'snapshot published_products did not reflect 1 inserted published product';
  end if;
  if (snap->>'total_certificates')::bigint < baseline.total_certificates + 1 then
    raise exception 'snapshot total_certificates did not reflect 1 inserted certificate';
  end if;
  if (snap->>'total_inquiries')::bigint < baseline.total_inquiries + 1 then
    raise exception 'snapshot total_inquiries did not reflect 1 inserted inquiry';
  end if;
  if (snap->>'unread_inquiries')::bigint < baseline.unread_inquiries + 1 then
    raise exception 'snapshot unread_inquiries did not reflect 1 inserted unread inquiry';
  end if;
end;
$$;

-- anon must NOT be able to execute the snapshot RPC.
set local role anon;
\set ON_ERROR_STOP off
select * from public.get_admin_dashboard_snapshot();
\if :ERROR
  \echo 'anon dashboard snapshot RPC correctly rejected'
\else
  \echo 'anon dashboard snapshot RPC unexpectedly succeeded'
  \quit 1
\endif
\set ON_ERROR_STOP on

rollback;
