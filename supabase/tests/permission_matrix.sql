do $$
declare
  public_read_tables text[] := array[
    'categories', 'subcategories', 'products', 'product_images', 'certificates',
    'company_profile', 'site_settings', 'homepage_content', 'page_content',
    'product_assets', 'projects', 'project_images', 'project_products'
  ];
  table_name text;
begin
  foreach table_name in array public_read_tables loop
    if not has_table_privilege('anon', format('public.%I', table_name), 'select') then
      raise exception 'anon lacks expected select on %', table_name;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.inquiries', 'select,insert') then
    raise exception 'anon unexpectedly has inquiry access';
  end if;
  if has_table_privilege('anon', 'public.analytics_events', 'select,insert') then
    raise exception 'anon unexpectedly has analytics access';
  end if;
  if has_function_privilege('anon', 'public.create_inquiry_with_items(jsonb,jsonb)', 'execute') then
    raise exception 'anon can execute atomic inquiry RPC';
  end if;
  if has_function_privilege('authenticated', 'public.create_inquiry_with_items(jsonb,jsonb)', 'execute') then
    raise exception 'ordinary authenticated can execute atomic inquiry RPC';
  end if;
  if has_function_privilege('anon', 'public.count_unread_inquiries()', 'execute') then
    raise exception 'anon can execute unread count RPC';
  end if;
  if has_function_privilege('authenticated', 'public.count_unread_inquiries()', 'execute') then
    raise exception 'ordinary authenticated can execute unread count RPC';
  end if;
  if not has_function_privilege('service_role', 'public.count_unread_inquiries()', 'execute') then
    raise exception 'service_role cannot execute unread count RPC';
  end if;
  if has_function_privilege('anon', 'public.get_admin_dashboard_snapshot()', 'execute') then
    raise exception 'anon can execute dashboard snapshot RPC';
  end if;
  if has_function_privilege('authenticated', 'public.get_admin_dashboard_snapshot()', 'execute') then
    raise exception 'ordinary authenticated can execute dashboard snapshot RPC';
  end if;
  if not has_function_privilege('service_role', 'public.get_admin_dashboard_snapshot()', 'execute') then
    raise exception 'service_role cannot execute dashboard snapshot RPC';
  end if;
  if not has_function_privilege('anon', 'public.search_published_products(text,uuid,uuid,integer,integer)', 'execute') then
    raise exception 'anon cannot execute public search RPC';
  end if;
  if has_function_privilege('public', 'public.is_admin()', 'execute') then
    raise exception 'PUBLIC can execute is_admin';
  end if;
  if not has_table_privilege('service_role', 'public.inquiries', 'insert')
     or not has_table_privilege('service_role', 'public.analytics_events', 'insert') then
    raise exception 'service_role lacks required server write privileges';
  end if;
  if not has_function_privilege('service_role', 'public.create_inquiry_with_items(jsonb,jsonb)', 'execute') then
    raise exception 'service_role cannot execute atomic inquiry RPC';
  end if;
end;
$$;

begin;
insert into public.categories (id, name_cn, slug, is_active) values
  ('00000000-0000-4000-8000-000000000020', '[REGRESSION TEST] public category', 'regression-public-category', true),
  ('00000000-0000-4000-8000-000000000021', '[REGRESSION TEST] hidden category', 'regression-hidden-category', false);
insert into public.products (id, category_id, name_cn, slug, is_published) values
  ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000020', '[REGRESSION TEST] public product', 'regression-public-product', true),
  ('00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000020', '[REGRESSION TEST] hidden product', 'regression-hidden-product', false);
insert into public.certificates (id, name_cn, is_published) values
  ('00000000-0000-4000-8000-000000000024', '[REGRESSION TEST] public certificate', true),
  ('00000000-0000-4000-8000-000000000025', '[REGRESSION TEST] hidden certificate', false);
insert into public.projects (id, slug, title_cn, is_published) values
  ('00000000-0000-4000-8000-000000000026', 'regression-public-project', '[REGRESSION TEST] public project', true),
  ('00000000-0000-4000-8000-000000000027', 'regression-hidden-project', '[REGRESSION TEST] hidden project', false);
insert into public.product_assets (id, product_id, asset_type, title_cn, file_url, is_published) values
  ('00000000-0000-4000-8000-000000000028', '00000000-0000-4000-8000-000000000022', 'catalog', '[REGRESSION TEST] public asset', '/regression-public.pdf', true),
  ('00000000-0000-4000-8000-000000000029', '00000000-0000-4000-8000-000000000022', 'catalog', '[REGRESSION TEST] hidden asset', '/regression-hidden.pdf', false);
set local role anon;
do $$
declare
  search_result jsonb;
begin
  if (select count(*) from public.categories where id in ('00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000021')) <> 1 then
    raise exception 'anon category visibility is incorrect';
  end if;
  if (select count(*) from public.products where id in ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000023')) <> 1 then
    raise exception 'anon product visibility is incorrect';
  end if;
  if (select count(*) from public.certificates where id in ('00000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-000000000025')) <> 1 then
    raise exception 'anon certificate visibility is incorrect';
  end if;
  if (select count(*) from public.projects where id in ('00000000-0000-4000-8000-000000000026', '00000000-0000-4000-8000-000000000027')) <> 1 then
    raise exception 'anon project visibility is incorrect';
  end if;
  if (select count(*) from public.product_assets where id in ('00000000-0000-4000-8000-000000000028', '00000000-0000-4000-8000-000000000029')) <> 1 then
    raise exception 'anon product asset visibility is incorrect';
  end if;
  search_result := public.search_published_products(
    'regression public product', null, null, 0, 20
  );
  if not (
    search_result->'items' @>
    '[{"id":"00000000-0000-4000-8000-000000000022"}]'::jsonb
  ) then
    raise exception 'anon public search RPC returned no published test product';
  end if;
end;
$$;
rollback;

begin;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000030', 'regression-admin@example.invalid');
insert into public.admin_profiles (id, email) values
  ('00000000-0000-4000-8000-000000000030', 'regression-admin@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000030', true);
insert into public.categories (id, name_cn, slug, is_active) values
  ('00000000-0000-4000-8000-000000000031', '[REGRESSION TEST] admin CRUD', 'regression-admin-crud', false);
update public.categories set is_active = true
where id = '00000000-0000-4000-8000-000000000031';
delete from public.categories
where id = '00000000-0000-4000-8000-000000000031';
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000099', true);
\set ON_ERROR_STOP off
insert into public.products (name_cn, slug) values ('forbidden', 'forbidden-authenticated-write');
\if :ERROR
  \echo 'ordinary authenticated CMS write correctly rejected'
\else
  \echo 'ordinary authenticated CMS write unexpectedly succeeded'
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback;
