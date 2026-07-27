# Two-Phase Upload Design (Working Document)

> **Status**: Working design document. Not yet implemented. The immediate
> WP-D hardening (strict Content-Length, per-actor rate limiting, post-
> arrayBuffer byte check, strict field allow-list) is already in
> `app/api/admin/storage/upload/route.ts` and provides defense-in-depth
> until this design is realized.
>
> **Hardening level achieved by WP-D**: Resource consumption at the
> route boundary is bounded, but the **in-memory exhaustion risk is not
> fully eliminated** — the route still buffers the entire file via
> `request.formData()` + `file.arrayBuffer()` before validating bytes.
> True end-to-end protection requires either (a) EdgeOne request body
> size limits at the platform WAF, or (b) the two-phase protocol below
> which streams into Storage and validates headers before the body is
> ever materialized in memory.

## 1. Motivation

The current single-phase upload route (`POST /api/admin/storage/upload`)
forces the server to:

1. Receive the entire multipart body into memory
2. Decode the multipart envelope
3. Buffer the entire file body via `arrayBuffer()`
4. THEN validate Magic Bytes / MIME / size

This means a single 21MB upload consumes ~21MB of resident memory, and
a concurrent burst of 20 uploads (within the rate-limit window) can
consume ~420MB. On EdgeOne Node.js runtime, this is a real DoS vector.

The two-phase protocol moves validation BEFORE the bytes are buffered:

1. Client requests an upload authorization (no body)
2. Server returns a signed upload URL pointing to a private temp path
3. Client uploads directly to Storage (private-assets bucket, temp dir)
4. Client requests finalize, providing the object path
5. Server validates object metadata + Magic Bytes via Storage HEAD +
   range-download of first N bytes (does NOT download the full object)
6. Server moves/copies the object to its final path
7. Server registers the StorageObjectRef + audit row

## 2. API Contract

### Phase 1: `POST /api/admin/storage/upload/authorize`

**Request** (JSON, ~256 bytes):
```json
{
  "purpose": "product-image",
  "filename": "cover.jpg",
  "mimeType": "image/jpeg",
  "size": 5242880
}
```

**Response** (200):
```json
{
  "uploadToken": "uuid",
  "signedUrl": "https://...supabase.co/storage/v1/object/private-assets/temp/{uuid}/cover.jpg",
  "expiresAt": "2026-07-27T12:00:00Z",
  "method": "PUT",
  "headers": {
    "Authorization": "Bearer ..."
  }
}
```

**Validation**:
- purpose must be a known purpose config
- filename + mimeType + size validated against purpose whitelist
- size <= per-purpose max (e.g. image 5MB / PDF 20MB)
- A `temp_uploads` row is inserted with status='authorized' and
  expires_at = NOW() + 5min
- The signed URL points to `private-assets/temp/{token}/{filename}`
- The signed URL has a short TTL (5 min)
- Rate limited: 20 authorizations / 5 min / admin actor

### Phase 2: `POST /api/admin/storage/upload/finalize`

**Request** (JSON):
```json
{
  "uploadToken": "uuid"
}
```

**Server flow**:
1. Look up `temp_uploads` row by token. Reject if missing, expired,
   or status != 'authorized'.
2. Mark row as 'finalizing' (atomic state transition).
3. Call Storage HEAD on the object path:
   - Verify object exists
   - Verify `Content-Length` matches declared `size`
   - Verify `Content-Type` matches declared `mimeType`
4. Range-download first 16 bytes (Magic Bytes window):
   - Verify Magic Bytes match declared MIME
5. Mark row as 'finalized' + insert `StorageObjectRef` + audit row.
6. Optionally move/rename the object from `temp/{token}/` to
   `{category}/{uuid}.{ext}` via Storage copy + delete.
7. Return the final `StorageObjectRef` to the caller.

**Failure handling**:
- HEAD fails → row marked 'failed', object left in temp (cleanup later)
- Range-download fails → row marked 'failed', object left in temp
- Magic Bytes mismatch → row marked 'rejected', object scheduled for
  cleanup
- Token reuse → 409 Conflict (idempotency)
- Expired token → 410 Gone

## 3. Required Database Changes (forward-only migrations)

### `temp_uploads` table

```sql
CREATE TABLE public.temp_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose TEXT NOT NULL,
  bucket TEXT NOT NULL DEFAULT 'private-assets',
  object_path TEXT NOT NULL,
  declared_mime_type TEXT NOT NULL,
  declared_size BIGINT NOT NULL,
  declared_filename TEXT NOT NULL,
  actor_id TEXT,
  actor_role TEXT,
  status TEXT NOT NULL DEFAULT 'authorized'
    CHECK (status IN ('authorized', 'finalizing', 'finalized', 'failed', 'rejected')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cleanup: delete expired rows that are still 'authorized' or 'failed'
CREATE INDEX idx_temp_uploads_expires_at ON public.temp_uploads (expires_at);
CREATE INDEX idx_temp_uploads_status ON public.temp_uploads (status);
```

### `temp_uploads` lifecycle RPCs

- `authorize_temp_upload(p_purpose, p_filename, p_mime, p_size, p_actor_id, p_actor_role)`
  - Validates purpose + MIME + size
  - Inserts row with status='authorized'
  - Returns row + signed URL
- `claim_temp_upload_for_finalize(p_token)`
  - SELECT FOR UPDATE SKIP LOCKED
  - status='authorized' AND expires_at > NOW()
  - Updates status='finalizing'
  - Returns row
- `complete_temp_upload_finalize(p_token, p_final_bucket, p_final_path, p_public_url)`
  - Atomic: update status='finalized', insert StorageObjectRef + audit
- `fail_temp_upload_finalize(p_token, p_reason)`
  - Update status='failed' or 'rejected'
  - Enqueue cleanup of temp object

### Storage cleanup

- Temp objects in `private-assets/temp/{token}/` are deleted by the
  existing `storage_cleanup_queue` dispatcher
- `enqueue_storage_cleanup` is called with reason='form_cancelled'
  when finalize fails or token expires

## 4. Limitations & Deferrals

This two-phase protocol is **not yet implemented** because:

1. Supabase Storage signed-URL upload requires the client to make a
   cross-origin PUT to the Supabase project domain. This requires CORS
   configuration on the Storage bucket, which is a deployment-side
   change that should be validated in Staging before production.
2. The `temp_uploads` table requires a new forward-only migration and
   accompanying tests (permission_matrix, lifecycle, stale recovery).
3. The finalize flow's range-download approach must be validated
   against Supabase Storage's Range header support — it's documented
   but not exercised by current code.
4. The current single-phase route is adequate for the admin-only
   upload path with the WP-D hardening; the two-phase protocol is
   motivated by hostile-traffic scenarios, not by the standard admin
   workflow.

## 5. Deployment Prerequisites (Interim)

Until the two-phase protocol is implemented, deployments MUST enforce:

1. **EdgeOne WAF request body size limit**: Set to 21MB
   (`MAX_REQUEST_BYTES`) at the platform layer. This prevents the
   Node.js process from ever receiving oversized bodies.
2. **EdgeOne WAF rate limit**: 20 POST requests / 5 min / IP for the
   `/api/admin/storage/upload` path. This is in addition to the
   in-process rate limiter, which is per-instance.
3. **EdgeOne connection concurrency limit**: Cap concurrent admin
   uploads to ~5 per IP to bound memory pressure.
4. **Node.js `--max-old-space-size`**: Set to at least 512MB to
   handle 5 concurrent 21MB uploads (5 × 21 = 105MB peak) plus base
   process memory.

These are documented in `docs/LAUNCH_CHECKLIST.md` and tracked as
production-readiness blockers.

## 6. Future Work

- Migrate `app/api/admin/storage/upload/route.ts` to two-phase
- Add `temp_uploads` migration + tests
- Add `app/api/admin/storage/upload/authorize/route.ts`
- Add `app/api/admin/storage/upload/finalize/route.ts`
- Add a `temp_uploads` cleanup dispatcher (similar to
  `outbox-processor.ts` and `storage_cleanup_queue` dispatcher)
- Once two-phase is live, remove the single-phase route OR keep it
  as a fallback for non-Supabase-Storage backends
