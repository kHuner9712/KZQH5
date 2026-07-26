do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end;
$$;

create extension if not exists pgcrypto;
create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz default now()
);
create or replace function auth.uid() returns uuid language sql stable set search_path = '' as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
-- Supabase auth.role() stub for disposable local database tests.
-- Returns the effective request role. Tests use `set local role anon` /
-- `set local role authenticated` / `set local role service_role`, which
-- makes current_user reflect the switched role. This mirrors how the real
-- Supabase auth.role() behaves under RLS evaluation.
create or replace function auth.role() returns text language sql stable as $$
  select current_user::text;
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;

create schema storage;
-- Minimal mirror of the real Supabase storage.buckets columns that the
-- application and migrations reference. Plain Postgres 16 does not ship
-- the Supabase Storage extension, so we recreate just enough of the schema
-- (id, name, public, allowed_mime_types, file_size_limit) for migrations
-- like 20260724170000_storage_bucket_hardening.sql to run in disposable
-- local database tests. This is a TEST fixture only — never shipped to
-- production, where Supabase provides the real storage.buckets table.
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  allowed_mime_types text[],
  file_size_limit bigint
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null default ''
);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated;
grant all on storage.buckets, storage.objects to service_role;
