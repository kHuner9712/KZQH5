do $$
declare
  public_read_tables text[] := array[
    'categories', 'subcategories', 'products', 'product_images', 'certificates',
    'company_profile', 'site_settings', 'homepage_content', 'page_content',
    'product_assets', 'projects', 'project_images', 'project_products'
  ];
  business_dml_tables text[] := array[
    'categories', 'subcategories', 'products', 'product_images',
    'certificates', 'company_profile', 'site_settings',
    'homepage_content', 'page_content', 'product_assets',
    'projects', 'project_images', 'project_products',
    'inquiries', 'inquiry_items'
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
  if has_function_privilege('anon', 'public.create_inquiry_with_items(jsonb,jsonb,uuid)', 'execute') then
    raise exception 'anon can execute atomic inquiry RPC';
  end if;
  if has_function_privilege('authenticated', 'public.create_inquiry_with_items(jsonb,jsonb,uuid)', 'execute') then
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
  if not has_function_privilege('service_role', 'public.create_inquiry_with_items(jsonb,jsonb,uuid)', 'execute') then
    raise exception 'service_role cannot execute atomic inquiry RPC';
  end if;

  -- ============================================================
  -- WORK PACKAGE A regression — authenticated MUST NOT have direct
  -- INSERT / UPDATE / DELETE on any backend business table.
  --
  -- Even when RLS policy `*_admin_all` would allow an admin (is_admin()
  -- = true) to write, the table-level GRANT is now revoked, so the
  -- PostgREST Data API cannot reach the RLS layer at all. This forces
  -- every backend write through /api/admin/** → service_role →
  -- transactional RPCs (audit, optimistic lock, Storage ref lifecycle).
  -- ============================================================
  foreach table_name in array business_dml_tables loop
    if has_table_privilege('authenticated', format('public.%I', table_name), 'insert') then
      raise exception 'authenticated still has INSERT on % — direct-write bypass not closed', table_name;
    end if;
    if has_table_privilege('authenticated', format('public.%I', table_name), 'update') then
      raise exception 'authenticated still has UPDATE on % — direct-write bypass not closed', table_name;
    end if;
    if has_table_privilege('authenticated', format('public.%I', table_name), 'delete') then
      raise exception 'authenticated still has DELETE on % — direct-write bypass not closed', table_name;
    end if;
  end loop;
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
insert into public.product_assets (id, product_id, asset_type, title_cn, file_url, is_published, access_level, authorization_status) values
  ('00000000-0000-4000-8000-000000000028', '00000000-0000-4000-8000-000000000022', 'catalog', '[REGRESSION TEST] public asset', '/regression-public.pdf', true, 'public', 'confirmed'),
  ('00000000-0000-4000-8000-000000000029', '00000000-0000-4000-8000-000000000022', 'catalog', '[REGRESSION TEST] hidden asset', '/regression-hidden.pdf', false, 'public', 'confirmed');
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

-- ============================================================
-- WORK PACKAGE A regression — admin (is_admin()=true) can NO LONGER
-- write directly to business tables via PostgREST. Every write must
-- go through /api/admin/** → service_role → transactional RPC.
--
-- We create admin_profiles rows for editor / admin / super_admin and
-- assert that NONE of them can INSERT / UPDATE / DELETE on the
-- business tables, even though the RLS policy `*_admin_all` would
-- previously have allowed it. The table-level GRANT is now revoked,
-- so the database rejects the DML before RLS is even consulted.
-- ============================================================

begin;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000030', 'regression-admin@example.invalid');
insert into public.admin_profiles (id, email, role) values
  ('00000000-0000-4000-8000-000000000030', 'regression-admin@example.invalid', 'admin');

-- Sanity check: the admin profile exists and is_admin() returns true
-- when running as this user. This proves the RLS policy WOULD have
-- allowed the write — the block must come from the GRANT revocation.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000030', true);
do $$
begin
  if not public.is_admin() then
    raise exception 'test setup broken: admin profile not detected by is_admin()';
  end if;
end;
$$;

-- INSERT must fail (permission denied at the GRANT layer, before RLS).
\set ON_ERROR_STOP off
insert into public.categories (id, name_cn, slug, is_active) values
  ('00000000-0000-4000-8000-000000000031', '[REGRESSION TEST] admin CRUD', 'regression-admin-crud', false);
\if :ERROR
  \echo 'admin direct INSERT on categories correctly rejected (GRANT revoked)'
\else
  \echo 'admin direct INSERT on categories unexpectedly succeeded — GRANT bypass NOT closed'
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback;

-- ============================================================
-- WORK PACKAGE A regression — editor (role='editor') cannot directly
-- write to business tables either, even though is_admin() returns true
-- for any admin_profiles row.
-- ============================================================
begin;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000040', 'regression-editor@example.invalid');
insert into public.admin_profiles (id, email, role) values
  ('00000000-0000-4000-8000-000000000040', 'regression-editor@example.invalid', 'editor');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000040', true);
do $$
begin
  if not public.is_admin() then
    raise exception 'test setup broken: editor profile not detected by is_admin()';
  end if;
end;
$$;
\set ON_ERROR_STOP off
insert into public.products (name_cn, slug) values ('forbidden-editor', 'forbidden-editor-write');
\if :ERROR
  \echo 'editor direct INSERT on products correctly rejected (GRANT revoked)'
\else
  \echo 'editor direct INSERT on products unexpectedly succeeded — GRANT bypass NOT closed'
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback;

-- ============================================================
-- WORK PACKAGE A regression — super_admin (role='super_admin') also
-- cannot directly write to business tables. The application layer
-- (/api/admin/**) is the only path that can perform writes, and it
-- uses service_role + transactional RPCs.
-- ============================================================
begin;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000050', 'regression-superadmin@example.invalid');
insert into public.admin_profiles (id, email, role) values
  ('00000000-0000-4000-8000-000000000050', 'regression-superadmin@example.invalid', 'super_admin');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000050', true);
do $$
begin
  if not public.is_admin() then
    raise exception 'test setup broken: super_admin profile not detected by is_admin()';
  end if;
end;
$$;
\set ON_ERROR_STOP off
insert into public.certificates (name_cn, is_published) values ('forbidden-super-admin', false);
\if :ERROR
  \echo 'super_admin direct INSERT on certificates correctly rejected (GRANT revoked)'
\else
  \echo 'super_admin direct INSERT on certificates unexpectedly succeeded — GRANT bypass NOT closed'
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback;

-- ============================================================
-- WORK PACKAGE A regression — ordinary authenticated user (no
-- admin_profiles row) cannot write either. This was already true
-- via RLS, but we keep the explicit assertion so a future migration
-- that re-grants DML to authenticated is caught even if the admin
-- profiles test setup changes.
-- ============================================================
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

-- ============================================================
-- WORK PACKAGE A regression — UPDATE and DELETE must also be
-- rejected for authenticated (admin / editor / super_admin alike).
-- We test UPDATE and DELETE on a pre-existing row that the admin
-- would normally be allowed to mutate via RLS.
-- ============================================================
begin;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000060', 'regression-admin2@example.invalid');
insert into public.admin_profiles (id, email, role) values
  ('00000000-0000-4000-8000-000000000060', 'regression-admin2@example.invalid', 'admin');
-- Seed a row as service_role (bypasses RLS) for the admin to attempt
-- UPDATE / DELETE on.
set local role service_role;
insert into public.categories (id, name_cn, slug, is_active) values
  ('00000000-0000-4000-8000-000000000061', '[REGRESSION TEST] seed for UPDATE/DELETE', 'regression-update-delete-seed', true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000060', true);
\set ON_ERROR_STOP off
update public.categories set is_active = false where id = '00000000-0000-4000-8000-000000000061';
\if :ERROR
  \echo 'admin direct UPDATE on categories correctly rejected (GRANT revoked)'
\else
  \echo 'admin direct UPDATE on categories unexpectedly succeeded — GRANT bypass NOT closed'
  \quit 1
\endif
\set ON_ERROR_STOP on
\set ON_ERROR_STOP off
delete from public.categories where id = '00000000-0000-4000-8000-000000000061';
\if :ERROR
  \echo 'admin direct DELETE on categories correctly rejected (GRANT revoked)'
\else
  \echo 'admin direct DELETE on categories unexpectedly succeeded — GRANT bypass NOT closed'
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback;
