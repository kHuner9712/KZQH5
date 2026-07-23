# Storage Security Review

> **Status:** Read-only review. This document does NOT modify Storage policies.
> Run the checks below to verify the current configuration before staging.

## Buckets

| Bucket            | Expected visibility | Purpose                                   |
| ----------------- | ------------------- | ----------------------------------------- |
| `public-assets`   | public              | Product images, certificates, catalog PDFs visible to anonymous visitors |
| `private-assets`  | private             | Internal/admin-only assets not meant for public visitors |

## Read-Only Checks

Run these via Supabase dashboard (Storage → Configuration) or the SQL editor.
They do not modify any policy.

### 1. Bucket visibility

```sql
-- public-assets should be public
select id, name, public
from storage.buckets
where name in ('public-assets', 'private-assets');
-- Expected: public-assets.public = true, private-assets.public = false
```

### 2. File size limit

```sql
select name, file_size_limit
from storage.buckets
where name in ('public-assets', 'private-assets');
```

Recommended limit: **50 MB** per file (covers large catalog PDFs).

### 3. Allowed MIME types

```sql
select name, allowed_mime_types
from storage.buckets
where name in ('public-assets', 'private-assets');
```

### 4. Anonymous list access on public bucket

Anonymous users should be able to READ objects in `public-assets` but should
NOT be able to list the entire bucket contents (to prevent enumeration).

```sql
-- Check RLS policies on storage.objects
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
order by policyname;
```

### 5. Admin write permissions

Admins (authenticated via service role or admin RLS) should have
INSERT / UPDATE / DELETE on `public-assets`.

### 6. Non-admin write restrictions

Anonymous and non-admin authenticated users must NOT have write access to
either bucket.

## Recommended MIME Type Allowlist

```
application/pdf
image/jpeg
image/png
image/webp
```

These cover all legitimate KZQ asset types: catalog PDFs, product photos,
certificate scans, and cover images.

## SVG Policy

### Risk

SVG files can contain embedded `<script>` tags and `onload` event handlers.
When served from the same origin as the application, an uploaded malicious
SVG becomes a **stored XSS** vector — the browser executes the script in the
site's origin, giving the attacker access to session cookies, inquiry data,
and admin tokens.

### Current status

If SVG is currently allowed in `allowed_mime_types`, it is a security risk
that must be explicitly justified.

### Recommendation

**Remove SVG from the allowlist** for both buckets unless there is a
specific, reviewed use case. KZQ product images, certificates, and catalog
PDFs do not require SVG.

If SVG must be kept:

1. Serve SVGs from a separate, sandboxed origin (different domain with
   `Content-Security-Policy: sandbox` and no cookies).
2. Strip `<script>` and event-handler attributes server-side before storing.
3. Set `Content-Disposition: attachment` on SVG responses to prevent
   inline rendering.
4. Never embed user-uploaded SVGs via `<img>` or `inline` in admin pages —
   use a sandboxed `<iframe>` with `sandbox="allow-same-origin"` only.

## Storage Policy Checklist

| Check                                              | Expected | Action if failing                |
| -------------------------------------------------- | -------- | -------------------------------- |
| `public-assets` bucket is public                   | true     | Update bucket visibility         |
| `private-assets` bucket is private                 | false    | Update bucket visibility         |
| Anonymous can READ `public-assets` objects         | true     | Add SELECT policy for `anon`     |
| Anonymous can LIST all `public-assets`             | false    | Restrict LIST policy             |
| Anonymous can WRITE to `public-assets`             | false    | Remove INSERT policy for `anon`  |
| Anonymous can WRITE to `private-assets`            | false    | Remove INSERT policy for `anon`  |
| Admin can INSERT/UPDATE/DELETE `public-assets`     | true     | Add write policy for admin role  |
| Admin can INSERT/UPDATE/DELETE `private-assets`    | true     | Add write policy for admin role  |
| `file_size_limit` is set                           | 50 MB    | Configure bucket limit           |
| `allowed_mime_types` excludes SVG                  | true     | Remove `image/svg+xml`           |
| `allowed_mime_types` includes PDF/JPEG/PNG/WEBP    | true     | Add missing types                |

## Important

- Do NOT automatically modify Storage policies during this review.
- Policy changes must be applied through a separate, reviewed change after
  this review is signed off.
- Always test anonymous access restrictions with a clean browser session
  (no admin cookies) after any policy change.
