do $$
begin
  if not exists (select 1 from public.admin_profiles where id = '00000000-0000-4000-8000-000000000001') then
    raise exception 'incremental upgrade removed the legacy administrator';
  end if;
  if not exists (select 1 from public.products where id = '00000000-0000-4000-8000-000000000002') then
    raise exception 'incremental upgrade removed the legacy product';
  end if;
  if not exists (select 1 from public.inquiries where id = '00000000-0000-4000-8000-000000000003') then
    raise exception 'incremental upgrade removed the legacy inquiry';
  end if;
end;
$$;
