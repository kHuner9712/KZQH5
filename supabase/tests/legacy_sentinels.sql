insert into auth.users (id, email)
values ('00000000-0000-4000-8000-000000000001', 'legacy-admin@example.test');
insert into public.admin_profiles (id, email, role)
values ('00000000-0000-4000-8000-000000000001', 'legacy-admin@example.test', 'admin');
insert into public.products (id, name_cn, slug, is_published)
values ('00000000-0000-4000-8000-000000000002', '[REGRESSION TEST] legacy product', 'regression-legacy-product', true);
insert into public.inquiries (id, name, interested_product, status, source)
values ('00000000-0000-4000-8000-000000000003', '[REGRESSION TEST] legacy inquiry', '[REGRESSION TEST] legacy product', 'new', 'migration-test');
