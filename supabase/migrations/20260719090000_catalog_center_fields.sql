-- KZQ Catalog Center extension
-- Adds catalog metadata only. Existing product_assets rows remain valid.

alter table public.product_assets
  add column if not exists catalog_topic_id text,
  add column if not exists cover_image_url text,
  add column if not exists published_at date,
  add column if not exists content_hash text;

create index if not exists product_assets_catalog_topic_idx
  on public.product_assets(catalog_topic_id, is_published, sort_order, created_at desc);

create index if not exists product_assets_content_hash_idx
  on public.product_assets(content_hash)
  where content_hash is not null;
