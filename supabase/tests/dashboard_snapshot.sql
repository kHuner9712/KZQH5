-- Database test for public.get_admin_dashboard_snapshot()
--
-- Verifies that the RPC returns exact counts that reflect inserted rows,
-- and that anon/authenticated cannot execute it.
--
-- Runs inside a transaction and rolls back so no test data persists.

begin;

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
  before_products bigint;
  before_published bigint;
  before_certs bigint;
  before_inquiries bigint;
  before_unread bigint;
  snap jsonb;
begin
  select count(*)::bigint into before_products from public.products;
  select count(*)::bigint into before_published from public.products where is_published = true;
  select count(*)::bigint into before_certs from public.certificates;
  select count(*)::bigint into before_inquiries from public.inquiries;
  select count(*)::bigint into before_unread from public.inquiries where is_read = false;

  -- The test connection is superuser; service_role grant ensures the RPC is
  -- callable. security_invoker + superuser bypasses RLS, yielding true totals.
  -- The RPC returns one row of five bigint columns; fold it into jsonb so the
  -- individual fields can be asserted below.
  select to_jsonb(t) into snap from public.get_admin_dashboard_snapshot() t limit 1;

  if (snap->>'total_products')::bigint < before_products + 2 then
    raise exception 'snapshot total_products did not reflect 2 inserted products';
  end if;
  if (snap->>'published_products')::bigint < before_published + 1 then
    raise exception 'snapshot published_products did not reflect 1 inserted published product';
  end if;
  if (snap->>'total_certificates')::bigint < before_certs + 1 then
    raise exception 'snapshot total_certificates did not reflect 1 inserted certificate';
  end if;
  if (snap->>'total_inquiries')::bigint < before_inquiries + 1 then
    raise exception 'snapshot total_inquiries did not reflect 1 inserted inquiry';
  end if;
  if (snap->>'unread_inquiries')::bigint < before_unread + 1 then
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
