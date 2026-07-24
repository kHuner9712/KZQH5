import { createBrowserSupabaseClient } from "./client";
import {
  extractFileExtension,
  generateStoragePath,
  IMAGE_ALLOWED_MIME,
  IMAGE_MAX_SIZE,
  PUBLIC_ASSETS_ALLOWED_MIME,
  PUBLIC_ASSETS_MAX_SIZE,
  validateFileUpload,
} from "@/lib/validation/storage";

// ============================================================
// Phase 4: Storage upload functions with full validation.
//
// Both functions now enforce:
//   1. MIME type allowlist (SVG excluded — stored XSS risk)
//   2. File size limit (defense-in-depth; bucket config is the real gate)
//   3. Magic bytes verification (prevents MIME spoofing)
//   4. Path sanitization (prevents path traversal via folder param)
//   5. MIME ↔ extension consistency
//
// The validation is shared with the server-side bucket config via
// the migration 20260724170000_storage_bucket_hardening.sql.
// ============================================================

/**
 * Reads the first N bytes of a File for magic bytes verification.
 * Returns a Uint8Array of the first 16 bytes (enough for all signatures).
 */
async function readFileHeader(file: File, byteCount = 16): Promise<Uint8Array> {
  const slice = file.slice(0, byteCount);
  const buffer = await slice.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Reads the first N bytes of a File and validates it against the
 * public-assets bucket rules.
 *
 * Shared by uploadPublicImage and uploadPublicFile so both enforce
 * magic bytes verification consistently.
 */
async function validateFileForUpload(
  file: File,
  allowedMime: readonly string[],
  maxSize: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Read the file header for magic bytes check
  let header: Uint8Array;
  try {
    header = await readFileHeader(file);
  } catch {
    return { ok: false, error: "无法读取文件内容" };
  }

  const result = validateFileUpload({
    mimeType: file.type,
    size: file.size,
    filename: file.name,
    bytes: header,
    allowedMime,
    maxSize,
  });

  if (!result.ok) {
    return { ok: false, error: result.error || "文件验证失败" };
  }

  return { ok: true };
}

// 上传公开图片到 public-assets bucket
// 仅在后台管理客户端调用，需要管理员登录态（RLS 校验）
export async function uploadPublicImage(
  file: File,
  folder: string
): Promise<{ url: string | null; error: string | null }> {
  // Phase 4: Full validation with magic bytes + path sanitization
  const validation = await validateFileForUpload(
    file,
    IMAGE_ALLOWED_MIME,
    IMAGE_MAX_SIZE,
  );
  if (!validation.ok) {
    return { url: null, error: validation.error };
  }

  const ext = extractFileExtension(file.name) || ".jpg";
  const fileName = generateStoragePath(folder, ext);
  if (!fileName) {
    return { url: null, error: "存储路径不合法" };
  }

  const supabase = createBrowserSupabaseClient();
  const { error } = await supabase.storage
    .from("public-assets")
    .upload(fileName, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type,
    });

  if (error) {
    return { url: null, error: error.message };
  }

  const { data } = supabase.storage
    .from("public-assets")
    .getPublicUrl(fileName);

  return { url: data.publicUrl, error: null };
}

// 上传公开展示文件。调用方必须先确认文件为展示版或水印版；内部源文件不得上传。
export async function uploadPublicFile(
  file: File,
  folder: string
): Promise<{ url: string | null; error: string | null }> {
  // Phase 4: Full validation with magic bytes + path sanitization
  const validation = await validateFileForUpload(
    file,
    PUBLIC_ASSETS_ALLOWED_MIME,
    PUBLIC_ASSETS_MAX_SIZE,
  );
  if (!validation.ok) {
    return { url: null, error: validation.error };
  }

  const ext = extractFileExtension(file.name) || ".bin";
  const fileName = generateStoragePath(folder, ext);
  if (!fileName) {
    return { url: null, error: "存储路径不合法" };
  }

  const supabase = createBrowserSupabaseClient();
  const { error } = await supabase.storage
    .from("public-assets")
    .upload(fileName, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type,
    });

  if (error) {
    return { url: null, error: error.message };
  }

  const { data } = supabase.storage
    .from("public-assets")
    .getPublicUrl(fileName);

  return { url: data.publicUrl, error: null };
}
