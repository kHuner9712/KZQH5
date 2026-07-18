create or replace function public.count_unread_inquiries()
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::bigint
  from public.inquiries
  where is_read = false;
$$;

revoke all on function public.count_unread_inquiries()
  from public, anon, authenticated;

grant execute on function public.count_unread_inquiries()
  to service_role;
