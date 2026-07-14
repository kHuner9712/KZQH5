insert into public.products (id, name_cn, name_en, slug, is_published)
values
  ('00000000-0000-4000-8000-000000000010', '[REGRESSION TEST] database name', 'Database Name', 'regression-database-name', true),
  ('00000000-0000-4000-8000-000000000011', '[REGRESSION TEST] unpublished', 'Unpublished', 'regression-unpublished', false)
on conflict (id) do update set is_published = excluded.is_published;

select public.create_inquiry_with_items(
  '{"name":"[REGRESSION TEST] atomic","phone":"13800000000","interested_product":"forged","language":"zh"}'::jsonb,
  '[{"product_id":"00000000-0000-4000-8000-000000000010","product_name_cn":"forged","product_slug":"forged","quantity":"10"}]'::jsonb
);

do $$
begin
  if not exists (
    select 1 from public.inquiry_items
    where product_id = '00000000-0000-4000-8000-000000000010'
      and product_name_cn = '[REGRESSION TEST] database name'
      and product_slug = 'regression-database-name'
  ) then
    raise exception 'database-owned product snapshot assertion failed';
  end if;
end;
$$;

create or replace function public.regression_fail_inquiry_item() returns trigger language plpgsql as $$
begin
  if new.quantity = '[REGRESSION TEST FAIL]' then raise exception 'forced item failure'; end if;
  return new;
end;
$$;
create trigger regression_fail_inquiry_item before insert on public.inquiry_items
for each row execute function public.regression_fail_inquiry_item();

\set ON_ERROR_STOP off
select public.create_inquiry_with_items(
  '{"name":"[REGRESSION TEST] rollback","phone":"13800000000","interested_product":"ignored","language":"zh"}'::jsonb,
  '[{"product_id":"00000000-0000-4000-8000-000000000010","quantity":"[REGRESSION TEST FAIL]"}]'::jsonb
);
\if :ERROR
  \echo 'forced item failure raised as expected'
\else
  \echo 'forced item failure unexpectedly succeeded'
  \quit 1
\endif
\set ON_ERROR_STOP on

do $$
begin
  if exists (select 1 from public.inquiries where name = '[REGRESSION TEST] rollback') then
    raise exception 'item failure left a partial inquiry';
  end if;
end;
$$;

drop trigger regression_fail_inquiry_item on public.inquiry_items;
drop function public.regression_fail_inquiry_item();
delete from public.inquiries where name like '[REGRESSION TEST]%';
delete from public.products where id in (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000011'
);
