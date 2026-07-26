-- ============================================================
-- Phase 4: Storage bucket hardening.
--
-- This migration enforces MIME type and file size limits at the
-- database level on the `public-assets` and `private-assets`
-- storage buckets. This is the SERVER-SIDE gatekeeper that cannot
-- be bypassed by client-side tricks (spoofed Content-Type, etc.).
--
-- Allowed MIME types (SVG excluded — stored XSS risk):
--   application/pdf
--   image/jpeg
--   image/png
--   image/webp
--
-- File size limit: 50 MB (covers large catalog PDFs).
--
-- IMPORTANT: This migration updates storage.buckets directly.
-- It does NOT create or delete buckets — only updates config on
-- existing ones. If a bucket doesn't exist, the UPDATE is a no-op.
-- ============================================================

-- 1. Harden public-assets bucket
update storage.buckets
set
  allowed_mime_types = array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp'
  ],
  file_size_limit = 52428800  -- 50 MB in bytes
where name = 'public-assets';

-- 2. Harden private-assets bucket (same restrictions)
update storage.buckets
set
  allowed_mime_types = array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp'
  ],
  file_size_limit = 52428800  -- 50 MB in bytes
where name = 'private-assets';

-- ============================================================
-- Verification (read-only): confirm the config was applied.
-- Run this separately via the SQL editor after migration.
-- ============================================================
-- select name, public, allowed_mime_types, file_size_limit
-- from storage.buckets
-- where name in ('public-assets', 'private-assets')
-- order by name;
