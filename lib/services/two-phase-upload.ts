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
//   - The signed URL has a short TTL (5 min).
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

/** Signed upload URL TTL (5 minutes). Must match the temp_uploads.expires_at default. */
export const SIGNED_UPLOAD_URL_TTL_SECONDS = 300;

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

  // 7. Generate signed upload URL via Supabase Storage
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

  // 8. Return the authorization response
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
  const { data: claimResult, error: claimError } = await client.rpc(
    "claim_temp_upload_for_finalize",
    { p_token: input.uploadToken },
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

  // 9. Complete the temp_uploads RPC.
  //
  // The RPC returns a JSONB object `{ok: boolean, error?: string, ...}`.
  // We must validate the business return value, not just the transport
  // error: transport error, null data, malformed structure, or
  // `ok !== true` are ALL failures. When the object has already been
  // moved to its final path but the RPC fails, we must NOT return
  // success to the caller — instead we attempt compensating deletion
  // of the moved object and, if that also fails, enqueue it for
  // cleanup so no permanent orphan is left behind. The temp_uploads
  // row is left in `finalizing` state for recover_stale_temp_uploads
  // to eventually mark as failed.
  const { data: completeData, error: completeError } = await client.rpc(
    "complete_temp_upload_finalize",
    {
      p_token: input.uploadToken,
      p_final_object_path: finalObjectPath,
      p_final_bucket: finalBucket,
    },
  );

  const completeResult = completeData as
    | { ok?: boolean; error?: string; already_finalized?: boolean }
    | null;

  const completeOk =
    !completeError &&
    completeResult !== null &&
    typeof completeResult === "object" &&
    completeResult.ok === true;

  if (!completeOk) {
    // Object was moved to its final path but the DB finalize failed.
    // Compensate by deleting the moved object so we do not leave a
    // permanent orphan AND a stuck temp_uploads row that still claims
    // success. Never leak the Supabase error payload — record only a
    // coarse, fixed-code reason for the fail RPC and server log.
    const rpcErrorTag = completeError
      ? "transport_error"
      : completeResult === null
        ? "null_response"
        : typeof completeResult !== "object" || completeResult.ok !== false
          ? "invalid_response"
          : (completeResult.error ?? "invalid_response");
    const compensationReason = `complete_rpc_failed:${rpcErrorTag}`;
    console.warn("TEMP_UPLOAD_COMPLETE_RPC_FAILED");

    const { error: finalDeleteError } = await client.storage
      .from(finalBucket)
      .remove([finalObjectPath]);

    if (!finalDeleteError) {
      // Compensation succeeded: the final object is gone. Try to
      // mark the temp_uploads row as failed so operators see the
      // failure in the dashboard; swallow failure of this best-effort
      // call since the primary error must still be returned.
      await failFinalize(client, input.uploadToken, compensationReason);
    } else {
      // Compensation failed: the moved object is still present. Enqueue
      // it for the cleanup dispatcher rather than returning success.
      await enqueueStorageCleanup({
        bucket: finalBucket,
        objectPath: finalObjectPath,
        reason: "orphan_detected",
      });
      await failFinalize(client, input.uploadToken, compensationReason);
    }

    return { ok: false, code: "FINALIZE_RPC_FAILED" };
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
