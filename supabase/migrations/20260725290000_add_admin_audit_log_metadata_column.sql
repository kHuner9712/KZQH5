-- ============================================================
-- 20260725290000_add_admin_audit_log_metadata_column.sql
-- ------------------------------------------------------------
-- Forward-only migration: add the missing metadata column to
-- public.admin_audit_log.
--
-- Background:
--   The table was originally created by 20260724180000 with only:
--     id, actor_id, actor_email, actor_role, action,
--     target_type, target_id, summary, created_at
--
--   However, many later migrations INSERT into admin_audit_log
--   using a metadata column (jsonb) instead of summary to
--   record structured audit context. Examples:
--     - 20260725170000 (catalog_asset.publish)
--     - 20260725190000 (catalog_asset.publish, authorization_confirm)
--     - 20260725220000 (project audit RPCs)
--     - 20260725230000 (cms content audit RPCs)
--     - 20260725240010 (catalog/certificate update_metadata)
--     - 20260725250000 (asset lifecycle)
--     - 20260725261000 (storage ref deletion lifecycle)
--     - 20260725270000 (source retention policy)
--     - 20260725280000 (managed storage registry coverage)
--
--   CREATE OR REPLACE FUNCTION does not type-check the function
--   body at definition time, so those migrations installed without
--   error. The failure only surfaced at runtime when the test
--   suite invoked the functions:
--     ERROR: column "metadata" of relation "admin_audit_log"
--            does not exist
--
-- Fix:
--   Add metadata jsonb as a nullable column. Nullable because
--   legacy audit entries (and any audit RPC that still uses the
--   summary text form) do not provide structured metadata.
--
--   A GIN index supports containment queries on the jsonb payload
--   (e.g. find every audit entry referencing a given cleanup_id).
--
-- Safety:
--   * Forward-only -- adds a column + an index + a comment.
--   * No data is altered or deleted.
--   * No existing policy, function, or trigger is modified.
--   * add column if not exists makes the migration idempotent.
-- ============================================================

-- ============================================================
-- A. Add metadata jsonb column
-- ============================================================
alter table public.admin_audit_log
  add column if not exists metadata jsonb;

comment on column public.admin_audit_log.metadata is
  'Structured audit context (bucket, path, cleanup_id, updated_fields, etc.). NULL when the audit entry only has a human-readable summary.';

-- ============================================================
-- B. GIN index for jsonb containment queries
-- ============================================================
-- jsonb_path_ops produces a smaller, faster index for containment
-- queries. The partial predicate where metadata is not null keeps
-- the index small by excluding legacy rows that only have a summary.
create index if not exists idx_admin_audit_log_metadata_gin
  on public.admin_audit_log using gin (metadata jsonb_path_ops)
  where metadata is not null;

-- ============================================================
-- C. Runtime assertion -- verify the column is present
-- ============================================================
-- This DO block is a belt-and-suspenders check that runs at the
-- END of the migration. If the ALTER TABLE above was silently
-- skipped for any reason, this raises immediately instead of
-- letting downstream migrations install functions that would
-- fail at runtime.
do $_$
declare
  v_count integer;
begin
  select count(*) into v_count
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'admin_audit_log'
      and column_name = 'metadata';
  if v_count < 1 then
    raise exception
      'admin_audit_log.metadata column is missing after migration 20260725290000'
      using errcode = 'P0001';
  end if;
end;
$_$;

-- ============================================================
-- End of migration
-- ============================================================
