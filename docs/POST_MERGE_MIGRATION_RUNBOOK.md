# Post-Merge Migration Runbook

> **Status:** Read-only pre-check. This runbook does NOT execute migrations.
> The two catalog migrations below are NOT yet applied to the production
> Supabase database. Apply them only after staging acceptance and before
> enabling the catalog feature in production.

## Migrations (strict order)

1. `supabase/migrations/20260719090000_catalog_center_fields.sql`
   - Adds nullable columns to `product_assets`:
     - `catalog_topic_id text`
     - `cover_image_url text`
     - `published_at date`
     - `content_hash text`
   - Adds indexes:
     - `product_assets_catalog_topic_idx`
     - `product_assets_content_hash_idx`
   - Existing rows remain valid; no data migration needed.

2. `supabase/migrations/20260721000000_catalog_viewer_analytics_events.sql`
   - Replaces `analytics_events_event_name_check` with a constraint that
     accepts all 19 event names (14 legacy + 5 new catalog viewer events).
   - Wrapped in an explicit transaction (drop + add) so a failure between
     DROP and ADD cannot leave the table without a check constraint.
   - Idempotent — re-running produces the same final constraint.
   - Does NOT modify existing rows.

## Pre-Execution Read-Only Checks

Run these BEFORE applying migrations. They must not modify any data.

```sql
-- 1. Row counts before migration
select count(*) from public.product_assets;
select count(*) from public.analytics_events;

-- 2. Verify product_assets columns BEFORE migration
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'product_assets';

-- 3. Current analytics event distribution
select event_name, count(*)
from public.analytics_events
group by event_name
order by event_name;

-- 4. Confirm the current constraint definition
select pg_get_constraintdef(oid)
from pg_constraint
where conname = 'analytics_events_event_name_check';
```

Record the row counts — they must be unchanged after migration.

## Backup Recommendation

Before applying migrations, back up:

- `public.product_assets` (full table + structure)
- `public.analytics_events` (full table + structure)
- Constraint and index definitions for both tables

### pg_dump command template

> Replace placeholders before running. Never commit real passwords.

```bash
# Full backup of both tables (data + schema)
pg_dump "$DATABASE_URL" \
  --table=public.product_assets \
  --table=public.analytics_events \
  --schema-only \
  --file=pre-migration-schema-$(date +%Y%m%d).sql

pg_dump "$DATABASE_URL" \
  --table=public.product_assets \
  --table=public.analytics_events \
  --data-only \
  --file=pre-migration-data-$(date +%Y%m%d).sql

# Constraint + index definitions
pg_dump "$DATABASE_URL" \
  --table=public.product_assets \
  --table=public.analytics_events \
  --schema-only \
  --no-owner \
  --no-privileges \
  | grep -iE 'constraint|index' \
  > pre-migration-constraints-$(date +%Y%m%d).txt
```

Alternatively use the Supabase dashboard:
**Project → Database → Backups → Create backup** before applying.

## Execution Order

Apply migrations in this exact order. Do not reorder:

1. `20260719090000_catalog_center_fields.sql` (schema additions)
2. `20260721000000_catalog_viewer_analytics_events.sql` (constraint swap)

Both migrations are idempotent and wrapped appropriately (the analytics
migration uses an explicit transaction).

## Post-Execution Verification

Run these AFTER migrations complete. All must pass:

```sql
-- 1. The four catalog fields now exist
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'product_assets'
  and column_name in ('catalog_topic_id', 'cover_image_url', 'published_at', 'content_hash')
order by column_name;
-- Expected: 4 rows

-- 2. Indexes exist
select indexname
from pg_indexes
where schemaname = 'public'
  and tablename = 'product_assets'
  and indexname in ('product_assets_catalog_topic_idx', 'product_assets_content_hash_idx');
-- Expected: 2 rows

-- 3. Analytics constraint accepts all 19 events
-- Insert a test row for each new event name, then roll back:
begin;
insert into public.analytics_events (event_name, locale, created_at)
select event, 'zh', now()
from (values
  ('catalog_open'), ('catalog_load_success'), ('catalog_load_failure'),
  ('catalog_copy_link'), ('catalog_open_external')
) as t(event);
-- If this succeeds, the constraint accepts the new events.
rollback;

-- 4. Legacy 14 events still accepted
begin;
insert into public.analytics_events (event_name, locale, created_at)
select event, 'zh', now()
from (values
  ('page_view'), ('product_view'), ('product_search'), ('category_click'),
  ('phone_click'), ('wechat_copy'), ('whatsapp_click'), ('email_click'),
  ('add_to_inquiry'), ('inquiry_start'), ('inquiry_success'),
  ('catalog_download'), ('certificate_view'), ('project_view')
) as t(event);
rollback;

-- 5. Row counts unchanged
select count(*) from public.product_assets;
select count(*) from public.analytics_events;
-- Must match pre-migration counts

-- 6. Anonymous RLS still works (run as anon role / via anon key)
-- The migrations do not touch RLS policies, so anonymous read behaviour
-- should be unchanged. Verify by querying with the anon key.
```

## Functional Verification

After schema verification:

- Backend admin can read and save catalog assets (product-assets page).
- Anonymous users can view published catalog assets.
- Catalog viewer opens PDFs/images without errors.
- Analytics events fire correctly for new event names.

## Rollback Notes

### Catalog fields (`20260719090000`)

The new columns are nullable. **Do not roll back** just because the
application layer has a bug — the columns do not affect existing rows.
If a column rollback is truly required:

```sql
alter table public.product_assets
  drop column if exists catalog_topic_id,
  drop column if exists cover_image_url,
  drop column if exists published_at,
  drop column if exists content_hash;

drop index if exists public.product_assets_catalog_topic_idx;
drop index if exists public.product_assets_content_hash_idx;
```

### Analytics constraint (`20260721000000`)

Rolling back the constraint restores the old 14-event list. **However**,
you must first confirm no rows use the 5 new event names — otherwise the
rollback will fail because existing rows would violate the restored
constraint.

```sql
-- Check for new event rows BEFORE rollback
select count(*)
from public.analytics_events
where event_name in (
  'catalog_open', 'catalog_load_success', 'catalog_load_failure',
  'catalog_copy_link', 'catalog_open_external'
);
-- If count > 0, rolling back will fail. Do NOT delete analytics data
-- to force the rollback — instead, keep the new constraint or migrate
-- the rows to 'catalog_download' explicitly if absolutely required.
```

**Never** provide a rollback script that silently deletes analytics data.

## Accepted 19 Event Names

```
page_view
product_view
product_search
category_click
phone_click
wechat_copy
whatsapp_click
email_click
add_to_inquiry
inquiry_start
inquiry_success
catalog_download
certificate_view
project_view
catalog_open
catalog_load_success
catalog_load_failure
catalog_copy_link
catalog_open_external
```

The first 14 are legacy (from `20260714125149`); the last 5 are new.
