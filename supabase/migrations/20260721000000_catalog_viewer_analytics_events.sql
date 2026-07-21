-- ============================================================
-- Catalog viewer analytics event taxonomy
--
-- The previous `catalog_download` event was used for ALL viewer
-- interactions (open, copy link, open external, load success/failure
-- and actual download). That made analytics meaningless — opening a
-- catalog looked identical to downloading it.
--
-- This migration replaces the existing check constraint with one that
-- accepts the new event taxonomy:
--   - catalog_open            — user opened the viewer (mount)
--   - catalog_load_success    — PDF/image finished loading
--   - catalog_load_failure    — PDF/image failed to load (timeout/404/etc.)
--   - catalog_copy_link       — user clicked "copy link"
--   - catalog_open_external  — user clicked "open in browser"
--   - catalog_download        — user clicked the download button (UNCHANGED)
--
-- The old `catalog_download` event name is kept so existing rows remain
-- valid and historical dashboards continue to work. The new names are
-- purely additive.
--
-- This migration is idempotent — re-running it produces the same final
-- constraint. It does NOT modify existing rows.
-- ============================================================

-- Drop the legacy constraint and re-create it with the extended event set.
-- `if exists` guards against re-running on databases where the constraint
-- was already replaced.
alter table public.analytics_events
  drop constraint if exists analytics_events_event_name_check;

alter table public.analytics_events
  add constraint analytics_events_event_name_check check (event_name in (
    'page_view', 'product_view', 'product_search', 'category_click',
    'phone_click', 'wechat_copy', 'whatsapp_click', 'email_click',
    'add_to_inquiry', 'inquiry_start', 'inquiry_success',
    'catalog_open', 'catalog_load_success', 'catalog_load_failure',
    'catalog_copy_link', 'catalog_open_external', 'catalog_download',
    'certificate_view', 'project_view'
  ));
