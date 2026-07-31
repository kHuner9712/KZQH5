// ============================================================
// two-phase-upload.ts — Server-side two-phase upload service
// ------------------------------------------------------------
// Phase 4: Implements the server-side logic for the two-phase
// large file upload protocol documented in
// docs/TWO_PHASE_UPLOAD_DESIGN.md.
//
// Two phases:
//   1. authorizeTempUpload — validates purpose + MIME + size,
//      inserts a temp_uploads row via RPC, generates a signed
//      upload URL via Supabase Storage createSignedUploadUrl.
//   2. finalizeTempUpload — claims the temp_uploads row (RPC),
//      verifies the uploaded object via Storage HEAD + range-
//      download of Magic Bytes, moves the object to its final
//      path, registers a storage_object_ref, completes the RPC.
//
// The single-phase route (POST /api/admin/storage/upload) remains
// as a fallback for non-Supabase-Storage backends and for clients
// that cannot make cross-origin PUTs.
//
// Security:
//   - All validation happens BEFORE the signed URL is issued.
//   - The signed URL points to a temp/ path under private-assets,
//     NOT the final path. The object is moved to its final path
//     only after finalize verification.
//   - The temp_uploads row has a 5-minute BUSINESS authorization
//     window (TEMP_UPLOAD_AUTHORIZATION_WINDOW_SECONDS). The Supabase
//     signed-upload-URL capability lifetime is server-controlled
//     (default 1h) and NOT configurable via the SDK — see the
//     constant docblock for the three-distinct-lifetimes breakdown.
//   - The temp_uploads row tracks the lifecycle so stale uploads
//     can be cleaned up.
//   - Magic Bytes verification on finalize prevents MIME spoofing.
//   - The final object path is server-generated ({category}/{uuid}.{ext})
//     so clients cannot control it.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  PRIVATE_ASSETS_BUCKET,
  PUBLIC_ASSETS_BUCKET,
  generatePrivateStoragePath,
  generatePublicStoragePath,
  type PrivateAssetCategory,
} from "@/lib/services/storage-upload";
import {
  resolvePurposeConfig,
  type StoragePurpose,
} from "@/lib/services/storage-purpose";
import { validateMimeType, verifyMagicBytes } from "@/lib/validation/storage";
import { enqueueStorageCleanup } from "@/lib/services/storage-upload";

// ============================================================
// Constants
// ============================================================

/**
 * Business authorization window for a two-phase upload (5 minutes).
 *
 * This is the lifetime of the `temp_uploads` row's `authorized` status:
 * after this window elapses without a finalize, the row is reaped by
 * `reap_expired_temp_uploads` and the temp object is enqueued for
 * cleanup. It MUST be shorter than the Supabase signed-upload-URL
 * capability lifetime so that cleanup never races with a still-valid
 * upload URL (which would let a stale URL write a permanent orphan).
 *
 * IMPORTANT — three distinct lifetimes are involved, do not conflate:
 *   1. Business authorization window (this constant, 5 min) — controls
 *      the temp_uploads row status and the cleanup dispatcher reap schedule.
 *   2. Supabase signed-upload-URL capability TTL — controlled by the
 *      Supabase Storage service, NOT by this code. `createSignedUploadUrl`
 *      accepts only `{ upsert }` and does NOT accept a TTL argument
 *      (verified against @supabase/storage-js 2.109.0). The service-side
 *      default is 1 hour; it cannot be lowered or raised from the client.
 *   3. Temp object cleanup protection period — the cleanup dispatcher
 *      must wait until BOTH the business window has expired AND the
 *      signed-URL capability window has elapsed before deleting a temp
 *      object, otherwise a still-valid URL could re-create an orphan.
 *
 * The `expiresAt` field returned to the caller is the business
 * authorization window deadline (item 1), NOT the signed URL expiry.
 */
export const TEMP_UPLOAD_AUTHORIZATION_WINDOW_SECONDS = 300;

/**
 * Per-MIME max file size for two-phase upload. The two-phase
 * protocol bypasses the EdgeOne 6 MB platform body limit (the
 * upload goes directly from browser to Supabase Storage), so
 * per-purpose limits up to the Supabase bucket's cap can be
 * restored.
 *
 * Images: 5 MB (Supabase bucket cap for images)
 * PDFs: 20 MB (restored to the pre-WP7 limit)
 */
export const TWO_PHASE_MAX_SIZE: Readonly<Record<string, number>> = {
  "image/jpeg": 5 * 1024 * 1024,
  "image/png": 5 * 1024 * 1024,
  "image/webp": 5 * 1024 * 1024,
  "application/pdf": 20 * 1024 * 1024,
};

/** Number of bytes to range-download for Magic Bytes verification. */
const MAGIC_BYTES_WINDOW = 16;

// ============================================================
// Types
// ============================================================

/** Shape of a temp_uploads row returned by the RPCs. */
interface TempUploadRow {
  id: string;
  purpose: string;
  bucket: string;
  object_path: string;
  declared_mime_type: string;
  declared_size: number;
  declared_filename: string;
  final_bucket: string;
  final_category: string;
  actor_id: string | null;
  actor_role: string | null;
  status: string;
  expires_at: string;
  finalized_object_path: string | null;
  finalized_at: string | null;
  failure_reason: string | null;
}

export interface AuthorizeUploadInput {
  purpose: StoragePurpose;
  filename: string;
  mimeType: string;
  size: number;
  actorId?: string | null;
  actorRole?: string | null;
}

export interface AuthorizeUploadResult {
  ok: boolean;
  code?: string;
  uploadToken?: string;
  signedUrl?: string;
  expiresAt?: string;
  method?: string;
  headers?: Record<string, string>;
  /** The temp object path the client should PUT to. For testing. */
  objectPath?: string;
}

export interface FinalizeUploadInput {
  uploadToken: string;
  actorId?: string | null;
  actorRole?: string | null;
}

export interface FinalizeUploadResult {
  ok: boolean;
  code?: string;
  bucket?: string;
  path?: string;
  publicUrl?: string | null;
  mimeType?: string;
  size?: number;
}

// ============================================================
// Phase 1: authorizeTempUpload
// ============================================================

export async function authorizeTempUpload(
  input: AuthorizeUploadInput,
): Promise<AuthorizeUploadResult> {
  // 1. Validate purpose
  const purposeConfig = resolvePurposeConfig(input.purpose);
  if (!purposeConfig) {
    return { ok: false, code: "INVALID_PURPOSE" };
  }

  // 2. Validate MIME type against purpose whitelist
  const mimeValidation = validateMimeType(
    input.mimeType,
    purposeConfig.allowedMimeTypes,
  );
  if (!mimeValidation.ok) {
    return { ok: false, code: "MIME_NOT_ALLOWED_FOR_PURPOSE" };
  }

  // 3. Validate size against per-MIME two-phase cap
  const maxSize = TWO_PHASE_MAX_SIZE[input.mimeType];
  if (!maxSize || input.size <= 0 || input.size > maxSize) {
    return { ok: false, code: "SIZE_EXCEEDS_LIMIT" };
  }

  // 4. Validate filename (basic — no path separators, no null bytes)
  if (!isValidFilename(input.filename)) {
    return { ok: false, code: "INVALID_FILENAME" };
  }

  // 5. Create admin client
  let client: SupabaseClient<Database>;
  try {
    client = createAdminClient();
  } catch {
    return { ok: false, code: "ADMIN_CLIENT_FAILED" };
  }

  // 6. Insert temp_uploads row via RPC
  const { data: rpcResult, error: rpcError } = await client.rpc(
    "authorize_temp_upload",
    {
      p_purpose: input.purpose,
      p_filename: input.filename,
      p_mime_type: input.mimeType,
      p_size: input.size,
      p_final_bucket: purposeConfig.bucket,
      p_final_category: purposeConfig.category,
      p_actor_id: input.actorId ?? null,
      p_actor_role: input.actorRole ?? null,
    },
  );

  const rpcData = rpcResult as { ok?: boolean; error?: string; row?: { id: string; object_path: string; expires_at: string } } | null;
  if (rpcError || !rpcData || rpcData.ok !== true) {
    const errorCode = rpcData?.error || rpcError?.message || "RPC_FAILED";
    return { ok: false, code: errorCode };
  }

  const row = rpcData.row!;
  const uploadToken = row.id;
  const objectPath = row.object_path;

  // 7. Generate signed upload URL via Supabase Storage.
  //
  // NOTE: `createSignedUploadUrl` does NOT accept a TTL argument —
  // its options bag is `{ upsert }` only (verified against
  // @supabase/storage-js 2.109.0). The signed-URL capability lifetime
  // is controlled by the Supabase Storage service (default 1 hour)
  // and cannot be lowered or raised from the client. The DB
  // `expires_at` (5 min) is the BUSINESS authorization window for the
  // temp_uploads row, NOT the signed-URL TTL — do not conflate them.
  const { data: signedData, error: signedError } = await client.storage
    .from(PRIVATE_ASSETS_BUCKET)
    .createSignedUploadUrl(objectPath);

  if (signedError || !signedData) {
    // Failed to issue signed URL — mark the temp_uploads row as failed
    // so the cleanup dispatcher can reap it.
    await client.rpc("fail_temp_upload_finalize", {
      p_token: uploadToken,
      p_reason: "signed_url_generation_failed",
      p_outcome: "failed",
    });

    return { ok: false, code: "SIGNED_URL_FAILED" };
  }

  // 8. Return the authorization response.
  //
  // `expiresAt` is the business authorization window deadline (the
  // temp_uploads row `expires_at`), NOT the Supabase signed-URL expiry.
  // The signed URL's actual capability lifetime is server-controlled
  // and not exposed to this code; callers must not treat `expiresAt`
  // as the signed-URL TTL.
  return {
    ok: true,
    uploadToken,
    signedUrl: signedData.signedUrl,
    expiresAt: row.expires_at,
    method: "PUT",
    headers: {
      "Content-Type": input.mimeType,
    },
    objectPath,
  };
}

// ============================================================
// Phase 2: finalizeTempUpload
// ============================================================

export async function finalizeTempUpload(
  input: FinalizeUploadInput,
): Promise<FinalizeUploadResult> {
  let client: SupabaseClient<Database>;
  try {
    client = createAdminClient();
  } catch {
    return { ok: false, code: "ADMIN_CLIENT_FAILED" };
  }

  // 1. Claim the temp_uploads row (atomic: authorized → finalizing)
  //
  // KZQ-P0-003: p_actor_id is now required by the claim RPC. The
  // function verifies that the caller's actor_id matches the row's
  // actor_id, so only the admin who authorized the upload can
  // finalize it. A null or mismatched actor_id is rejected with a
  // fixed error code ('invalid_actor' or 'actor_mismatch').
  const { data: claimResult, error: claimError } = await client.rpc(
    "claim_temp_upload_for_finalize",
    { p_token: input.uploadToken, p_actor_id: input.actorId ?? null },
  );

  const claimData = claimResult as { ok?: boolean; error?: string; row?: TempUploadRow } | null;
  if (claimError || !claimData || claimData.ok !== true) {
    const errorCode = claimData?.error || claimError?.message || "CLAIM_FAILED";
    return { ok: false, code: errorCode };
  }

  const row = claimData.row!;
  const tempObjectPath = row.object_path;
  const declaredMimeType = row.declared_mime_type;
  const declaredSize = row.declared_size;
  const finalBucket = row.final_bucket;
  const finalCategory = row.final_category;

  // 2. Verify the object exists via Storage list (HEAD equivalent)
  const tempDir = tempObjectPath.substring(0, tempObjectPath.lastIndexOf("/"));
  const tempFilename = tempObjectPath.substring(tempObjectPath.lastIndexOf("/") + 1);

  const { data: listData, error: listError } = await client.storage
    .from(PRIVATE_ASSETS_BUCKET)
    .list(tempDir, { search: tempFilename, limit: 1 });

  if (listError || !listData || listData.length === 0) {
    await failFinalize(client, input.uploadToken, "object_not_found");
    return { ok: false, code: "OBJECT_NOT_FOUND" };
  }

  const objectInfo = listData[0];
  // Verify Content-Length matches declared size
  if (objectInfo.metadata?.size !== undefined) {
    const actualSize = objectInfo.metadata.size as number;
    if (actualSize !== declaredSize) {
      await failFinalize(
        client,
        input.uploadToken,
        `size_mismatch:expected=${declaredSize},actual=${actualSize}`,
        "rejected",
      );
      await enqueueStorageCleanup({
        bucket: PRIVATE_ASSETS_BUCKET,
        objectPath: tempObjectPath,
        reason: "orphan_detected",
      });
      return { ok: false, code: "SIZE_MISMATCH" };
    }
  }

  // 3. Range-download first N bytes for Magic Bytes verification
  const { data: rangeData, error: rangeError } = await client.storage
    .from(PRIVATE_ASSETS_BUCKET)
    .createSignedUrl(tempObjectPath, 60);

  if (rangeError || !rangeData) {
    await failFinalize(client, input.uploadToken, "range_download_failed");
    await enqueueStorageCleanup({
      bucket: PRIVATE_ASSETS_BUCKET,
      objectPath: tempObjectPath,
      reason: "orphan_detected",
    });
    return { ok: false, code: "RANGE_DOWNLOAD_FAILED" };
  }

  let magicBytes: Uint8Array;
  try {
    const response = await fetch(rangeData.signedUrl, {
      method: "GET",
      headers: { Range: `bytes=0-${MAGIC_BYTES_WINDOW - 1}` },
    });
    if (!response.ok) {
      await failFinalize(client, input.uploadToken, "magic_bytes_fetch_failed");
      await enqueueStorageCleanup({
        bucket: PRIVATE_ASSETS_BUCKET,
        objectPath: tempObjectPath,
        reason: "orphan_detected",
      });
      return { ok: false, code: "MAGIC_BYTES_FETCH_FAILED" };
    }
    const buffer = await response.arrayBuffer();
    magicBytes = new Uint8Array(buffer);
  } catch {
    await failFinalize(client, input.uploadToken, "magic_bytes_fetch_exception");
    await enqueueStorageCleanup({
      bucket: PRIVATE_ASSETS_BUCKET,
      objectPath: tempObjectPath,
      reason: "orphan_detected",
    });
    return { ok: false, code: "MAGIC_BYTES_FETCH_FAILED" };
  }

  // 4. Verify Magic Bytes match declared MIME
  const magicValidation = verifyMagicBytes(magicBytes, declaredMimeType);
  if (!magicValidation.ok) {
    await failFinalize(
      client,
      input.uploadToken,
      `magic_bytes_mismatch:${magicValidation.error}`,
      "rejected",
    );
    await enqueueStorageCleanup({
      bucket: PRIVATE_ASSETS_BUCKET,
      objectPath: tempObjectPath,
      reason: "orphan_detected",
    });
    return { ok: false, code: "MAGIC_BYTES_MISMATCH" };
  }

  // 5. Generate the final object path
  const ext = getExtensionFromFilename(row.declared_filename);
  let finalObjectPath: string;
  if (finalBucket === PRIVATE_ASSETS_BUCKET) {
    finalObjectPath = generatePrivateStoragePath(
      finalCategory as PrivateAssetCategory,
      ext,
    );
  } else {
    const publicPath = generatePublicStoragePath(finalCategory, ext);
    if (!publicPath) {
      await failFinalize(client, input.uploadToken, "path_generation_failed");
      await enqueueStorageCleanup({
        bucket: PRIVATE_ASSETS_BUCKET,
        objectPath: tempObjectPath,
        reason: "orphan_detected",
      });
      return { ok: false, code: "PATH_GENERATION_FAILED" };
    }
    finalObjectPath = publicPath;
  }

  // 6. Copy the object from temp/ to its final path WITHIN private-assets
  const { error: copyError } = await client.storage
    .from(PRIVATE_ASSETS_BUCKET)
    .copy(tempObjectPath, finalObjectPath);

  if (copyError) {
    await failFinalize(client, input.uploadToken, `copy_failed:${copyError.message}`);
    await enqueueStorageCleanup({
      bucket: PRIVATE_ASSETS_BUCKET,
      objectPath: tempObjectPath,
      reason: "orphan_detected",
    });
    return { ok: false, code: "COPY_FAILED" };
  }

  // 7. If the final bucket is public-assets, cross-bucket move:
  //    download from private-assets → upload to public-assets.
  let finalPublicUrl: string | null = null;
  if (finalBucket === PUBLIC_ASSETS_BUCKET) {
    const { data: downloadData, error: downloadError } = await client.storage
      .from(PRIVATE_ASSETS_BUCKET)
      .download(finalObjectPath);

    if (downloadError || !downloadData) {
      await client.storage.from(PRIVATE_ASSETS_BUCKET).remove([finalObjectPath]);
      await failFinalize(client, input.uploadToken, "cross_bucket_download_failed");
      await enqueueStorageCleanup({
        bucket: PRIVATE_ASSETS_BUCKET,
        objectPath: tempObjectPath,
        reason: "orphan_detected",
      });
      return { ok: false, code: "CROSS_BUCKET_MOVE_FAILED" };
    }

    const { error: publicUploadError } = await client.storage
      .from(PUBLIC_ASSETS_BUCKET)
      .upload(finalObjectPath, downloadData, {
        cacheControl: "3600",
        upsert: false,
        contentType: declaredMimeType,
      });

    if (publicUploadError) {
      await client.storage.from(PRIVATE_ASSETS_BUCKET).remove([finalObjectPath]);
      await failFinalize(client, input.uploadToken, "cross_bucket_upload_failed");
      await enqueueStorageCleanup({
        bucket: PRIVATE_ASSETS_BUCKET,
        objectPath: tempObjectPath,
        reason: "orphan_detected",
      });
      return { ok: false, code: "CROSS_BUCKET_MOVE_FAILED" };
    }

    // Remove the temp copy from private-assets
    await client.storage.from(PRIVATE_ASSETS_BUCKET).remove([finalObjectPath]);

    const { data: publicUrlData } = client.storage
      .from(PUBLIC_ASSETS_BUCKET)
      .getPublicUrl(finalObjectPath);

    finalPublicUrl = publicUrlData?.publicUrl ?? null;
  }

  // 8. Delete the original temp object
  const { error: tempDeleteError } = await client.storage
    .from(PRIVATE_ASSETS_BUCKET)
    .remove([tempObjectPath]);

  if (tempDeleteError) {
    // Non-fatal: the temp object is orphaned but the finalize
    // succeeded. Enqueue cleanup.
    await enqueueStorageCleanup({
      bucket: PRIVATE_ASSETS_BUCKET,
      objectPath: tempObjectPath,
      reason: "orphan_detected",
    });
  }

  // 9. Complete the temp_uploads RPC — strict parsing.
  //
  // The RPC returns a JSONB object: { ok: boolean, error?: string,
  // already_finalized?: boolean, row?: ... }. We must treat ALL of
  // these as failures:
  //   - transport error (network/timeout)
  //   - null data
  //   - invalid structure (no ok field / non-boolean ok)
  //   - ok !== true
  //
  // When the object has already been moved to its final path but the
  // completion RPC fails, we MUST NOT return success to the client.
  // Doing so would leave the database (temp_uploads.status still
  // 'finalizing') inconsistent with Storage (final object exists),
  // producing a silent permanent orphan that no cleanup task knows
  // about. Instead, perform reliable compensation: delete the moved
  // final object so Storage and DB stay consistent, mark the row as
  // failed, and return a fixed error code.
  const { data: completeResult, error: completeError } = await client.rpc(
    "complete_temp_upload_finalize",
    {
      p_token: input.uploadToken,
      p_final_object_path: finalObjectPath,
      p_final_bucket: finalBucket,
    },
  );

  const completeData =
    completeResult as { ok?: boolean; error?: string; already_finalized?: boolean } | null;

  if (completeError || !completeData || completeData.ok !== true) {
    // Compensation: the object was moved to its final path in steps
    // 6-7 but the DB completion failed. Delete the final object so we
    // do not leave a permanent orphan that the DB does not reference.
    // If compensation fails, enqueue cleanup as a safety net.
    await compensateFinalObject(client, finalBucket, finalObjectPath);
    await failFinalize(client, input.uploadToken, "complete_rpc_failed", "failed");

    // Fixed log code — never log the Supabase error payload.
    console.warn("TEMP_UPLOAD_COMPLETE_RPC_FAILED");

    return { ok: false, code: "COMPLETE_RPC_FAILED" };
  }

  // 10. Return the final result
  return {
    ok: true,
    bucket: finalBucket,
    path: finalObjectPath,
    publicUrl: finalPublicUrl,
    mimeType: declaredMimeType,
    size: declaredSize,
  };
}

// ============================================================
// Helpers
// ============================================================

function isValidFilename(filename: string): boolean {
  if (!filename || filename.length === 0 || filename.length > 255) return false;
  if (filename.includes("/") || filename.includes("\\")) return false;
  if (filename.includes("\0")) return false;
  if (filename === "." || filename === "..") return false;
  if (filename.startsWith(".")) return false;
  if (/[\x00-\x1f]/.test(filename)) return false;
  return true;
}

function getExtensionFromFilename(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1 || lastDot === filename.length - 1) return "";
  return filename.substring(lastDot + 1).toLowerCase();
}

async function failFinalize(
  client: SupabaseClient<Database>,
  token: string,
  reason: string,
  outcome: "failed" | "rejected" = "failed",
): Promise<void> {
  try {
    await client.rpc("fail_temp_upload_finalize", {
      p_token: token,
      p_reason: reason,
      p_outcome: outcome,
    });
  } catch {
    // Swallow — the original error is more important.
  }
}

/**
 * Compensation: delete the final object that was moved to its final
 * path before the completion RPC failed. This keeps Storage consistent
 * with the database (temp_uploads row stays in 'failed' state, no
 * orphaned final object exists).
 *
 * If the compensation delete itself fails, enqueue the object for
 * async cleanup as a safety net.
 *
 * This function NEVER throws — compensation failure is reported via
 * the cleanup enqueue, not via exceptions.
 */
async function compensateFinalObject(
  client: SupabaseClient<Database>,
  finalBucket: string,
  finalObjectPath: string,
): Promise<void> {
  const bucket =
    finalBucket === PUBLIC_ASSETS_BUCKET ? PUBLIC_ASSETS_BUCKET : PRIVATE_ASSETS_BUCKET;

  try {
    const { error: removeError } = await client.storage
      .from(bucket)
      .remove([finalObjectPath]);

    if (removeError) {
      // Compensation delete failed — enqueue async cleanup.
      await enqueueStorageCleanup({
        bucket: finalBucket,
        objectPath: finalObjectPath,
        reason: "orphan_detected",
      });
    }
  } catch {
    // Compensation delete threw — enqueue async cleanup.
    await enqueueStorageCleanup({
      bucket: finalBucket,
      objectPath: finalObjectPath,
      reason: "orphan_detected",
    });
  }
}
