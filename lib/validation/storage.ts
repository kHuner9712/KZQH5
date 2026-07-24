// ============================================================
// Phase 4: Shared storage upload validation.
//
// This module is the single source of truth for what files may be
// uploaded to Supabase Storage. It enforces:
//   1. MIME type allowlist (per bucket)
//   2. File size limits (per bucket)
//   3. Magic bytes verification (file content matches declared MIME)
//   4. Path sanitization (no path traversal in folder/filename)
//
// Used by:
//   - lib/supabase/storage.ts (client-side upload functions)
//   - scripts/cleanup-orphaned-assets.mjs (cleanup verification)
//
// Server-side enforcement is ALSO applied via the migration
// 20260724170000_storage_bucket_hardening.sql which sets
// allowed_mime_types and file_size_limit on storage.buckets.
// Client-side validation here is defense-in-depth; the bucket
// config is the real gatekeeper.
// ============================================================

/**
 * Allowed MIME types for the public-assets bucket.
 * SVG is intentionally excluded — it is a stored-XSS vector.
 */
export const PUBLIC_ASSETS_ALLOWED_MIME: readonly string[] = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/**
 * Maximum file size for the public-assets bucket: 50 MB.
 * Covers large catalog PDFs while preventing abuse.
 */
export const PUBLIC_ASSETS_MAX_SIZE = 50 * 1024 * 1024;

/**
 * Allowed MIME types for image uploads (subset of public-assets).
 * Used by uploadPublicImage which only accepts images.
 */
export const IMAGE_ALLOWED_MIME: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/**
 * Maximum image file size: 10 MB.
 * Images should be smaller than PDFs.
 */
export const IMAGE_MAX_SIZE = 10 * 1024 * 1024;

/**
 * Allowed extensions per MIME type, for cross-validation.
 */
const MIME_EXTENSION_MAP: Readonly<Record<string, readonly string[]>> = {
  "application/pdf": [".pdf"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
};

/**
 * Magic bytes (file signatures) for each allowed MIME type.
 * The key is the MIME type; the value is an array of byte sequences
 * where ANY match is sufficient (e.g., JPEG has FFD8FF variants).
 *
 * Each byte sequence is a prefix of the file content. We compare the
 * first N bytes of the file against these signatures.
 */
const MAGIC_BYTES: Readonly<Record<string, readonly number[][]>> = {
  // PDF: starts with %PDF-
  "application/pdf": [[0x25, 0x50, 0x44, 0x46, 0x2d]],
  // JPEG: starts with FF D8 FF
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  // PNG: starts with 89 50 4E 47 0D 0A 1A 0A
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  // WebP: starts with RIFF....WEBP
  // We check bytes 0-3 = "RIFF" and bytes 8-11 = "WEBP"
  "image/webp": [
    [0x52, 0x49, 0x46, 0x46], // "RIFF" — further check offset 8 for "WEBP"
  ],
};

export interface StorageValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validates the MIME type against an allowlist.
 */
export function validateMimeType(
  mimeType: string,
  allowed: readonly string[],
): StorageValidationResult {
  if (!mimeType) {
    return { ok: false, error: "缺少 MIME 类型" };
  }
  const lower = mimeType.toLowerCase().trim();
  if (!allowed.includes(lower)) {
    return {
      ok: false,
      error: `不支持的文件类型:${mimeType}(仅支持 ${allowed.join(", ")})`,
    };
  }
  return { ok: true };
}

/**
 * Validates the file size against a maximum.
 */
export function validateFileSize(
  size: number,
  max: number,
): StorageValidationResult {
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return { ok: false, error: "文件大小无效" };
  }
  if (size > max) {
    const maxMB = Math.floor(max / (1024 * 1024));
    return { ok: false, error: `文件大小超过上限(最大 ${maxMB}MB)` };
  }
  return { ok: true };
}

/**
 * Verifies that the file content's magic bytes match the declared MIME type.
 *
 * This prevents an attacker from uploading a malicious file (e.g., an HTML
 * file with JavaScript) with a spoofed `image/jpeg` MIME type. The browser
 * `File.type` property is derived from the file extension and is trivially
 * spoofable; magic bytes are derived from the actual file content and are
 * much harder to fake.
 *
 * For WebP, we check the RIFF header at offset 0 AND the WEBP tag at offset 8.
 *
 * @param bytes - The first 16+ bytes of the file (we read at most 12).
 * @param mimeType - The declared MIME type to verify against.
 * @returns { ok: true } if magic bytes match, { ok: false, error } otherwise.
 */
export function verifyMagicBytes(
  bytes: Uint8Array,
  mimeType: string,
): StorageValidationResult {
  const lower = mimeType.toLowerCase().trim();
  const signatures = MAGIC_BYTES[lower];

  if (!signatures) {
    // No signature defined for this MIME type — allow it (MIME check already passed)
    return { ok: true };
  }

  if (!bytes || bytes.length < 4) {
    return { ok: false, error: "文件内容过短,无法验证类型" };
  }

  for (const sig of signatures) {
    if (bytes.length < sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (bytes[i] !== sig[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      // Special case for WebP: also verify "WEBP" at offset 8
      if (lower === "image/webp") {
        if (bytes.length < 12) {
          return { ok: false, error: "WebP 文件头不完整" };
        }
        const webpTag = [0x57, 0x45, 0x42, 0x50]; // "WEBP"
        for (let i = 0; i < 4; i++) {
          if (bytes[8 + i] !== webpTag[i]) {
            return { ok: false, error: "文件内容与 WebP 格式不匹配" };
          }
        }
      }
      return { ok: true };
    }
  }

  return {
    ok: false,
    error: `文件内容与声明类型(${mimeType})不匹配`,
  };
}

/**
 * Sanitizes a storage path component (folder or filename) to prevent
 * path traversal attacks.
 *
 * - Strips leading/trailing slashes and whitespace
 * - Removes ".." segments
 * - Removes null bytes
 * - Removes backslashes
 * - Only allows alphanumeric, dash, underscore, dot, and forward slash
 *   (forward slash is needed for subfolders like "products/images")
 *
 * @param input - The raw path component from user input
 * @returns The sanitized path, or null if it cannot be sanitized
 */
export function sanitizeStoragePath(input: string): string | null {
  if (!input || typeof input !== "string") return null;

  // Remove null bytes and backslashes
  let out = input.replace(/\0/g, "").replace(/\\/g, "");

  // Strip leading/trailing whitespace and slashes
  out = out.trim().replace(/^\/+|\/+$/g, "");

  if (!out) return null;

  // Split into segments and validate each one.
  // If ANY segment is ".." or ".", reject the entire path.
  // This is more conservative than filtering (which would silently
  // produce a different path than the user intended).
  const rawSegments = out.split("/");
  const segments: string[] = [];

  for (const seg of rawSegments) {
    // Reject path traversal segments
    if (seg === ".." || seg === ".") {
      return null;
    }
    // Each segment must match the allowed character set
    if (!/^[a-zA-Z0-9._-]+$/.test(seg)) {
      // Skip segments with invalid characters rather than rejecting the
      // entire path — this handles edge cases like trailing slashes that
      // produce empty segments.
      if (seg === "") continue;
      return null;
    }
    segments.push(seg);
  }

  if (segments.length === 0) return null;

  // Rejoin and verify the result doesn't escape the bucket root
  const result = segments.join("/");
  if (result.includes("..") || result.startsWith("/")) {
    return null;
  }

  return result;
}

/**
 * Extracts and validates the file extension from a filename or URL.
 * Returns the extension WITH the leading dot (e.g., ".pdf"), lowercased.
 * Returns empty string if no valid extension is found.
 */
export function extractFileExtension(filename: string): string {
  if (!filename) return "";
  // Strip query string and hash
  const cleaned = filename.split("?")[0].split("#")[0];
  const match = cleaned.match(/\.([a-z0-9]{2,5})$/i);
  return match ? `.${match[1].toLowerCase()}` : "";
}

/**
 * Cross-validates MIME type and file extension for consistency.
 *
 * @param mimeType - The declared MIME type
 * @param extension - The file extension (with leading dot, e.g. ".pdf")
 * @returns { ok: true } if consistent, { ok: false, error } otherwise.
 */
export function validateMimeExtensionConsistency(
  mimeType: string,
  extension: string,
): StorageValidationResult {
  if (!mimeType || !extension) {
    // If either is missing, we can't cross-validate; allow (other checks cover this)
    return { ok: true };
  }

  const lower = mimeType.toLowerCase().trim();
  const expectedExtensions = MIME_EXTENSION_MAP[lower];

  if (!expectedExtensions) {
    // MIME not in our map — allow (the MIME allowlist check is the gatekeeper)
    return { ok: true };
  }

  if (!expectedExtensions.includes(extension.toLowerCase())) {
    return {
      ok: false,
      error: `MIME 类型与扩展名不匹配:MIME=${mimeType},扩展名=${extension}`,
    };
  }

  return { ok: true };
}

/**
 * Full validation pipeline for a file upload.
 *
 * Callers should:
 *   1. Read the first 16 bytes of the file (enough for all signatures)
 *   2. Call this function with the file metadata and bytes
 *
 * @param params - File metadata
 * @param params.mimeType - The file's MIME type (from File.type)
 * @param params.size - The file size in bytes (from File.size)
 * @param params.filename - The original filename (for extension extraction)
 * @param params.bytes - The first 16+ bytes of the file content
 * @param params.allowedMime - The allowed MIME types for this bucket
 * @param params.maxSize - The maximum file size for this bucket
 */
export function validateFileUpload(params: {
  mimeType: string;
  size: number;
  filename: string;
  bytes: Uint8Array;
  allowedMime: readonly string[];
  maxSize: number;
}): StorageValidationResult {
  const { mimeType, size, filename, bytes, allowedMime, maxSize } = params;

  // 1. MIME type allowlist
  const mimeResult = validateMimeType(mimeType, allowedMime);
  if (!mimeResult.ok) return mimeResult;

  // 2. File size
  const sizeResult = validateFileSize(size, maxSize);
  if (!sizeResult.ok) return sizeResult;

  // 3. Magic bytes
  const magicResult = verifyMagicBytes(bytes, mimeType);
  if (!magicResult.ok) return magicResult;

  // 4. MIME ↔ extension consistency
  const ext = extractFileExtension(filename);
  if (ext) {
    const consistencyResult = validateMimeExtensionConsistency(mimeType, ext);
    if (!consistencyResult.ok) return consistencyResult;
  }

  return { ok: true };
}

/**
 * Generates a safe storage path for an uploaded file.
 *
 * @param folder - The folder path (will be sanitized)
 * @param extension - The file extension (with leading dot, e.g. ".pdf")
 * @returns A safe path like "products/1717000000-a1b2c3.pdf", or null if
 *          the folder cannot be sanitized.
 */
export function generateStoragePath(
  folder: string,
  extension: string,
): string | null {
  const safeFolder = sanitizeStoragePath(folder);
  if (!safeFolder) return null;

  // Sanitize the extension: only allow alphanumeric after the dot
  const safeExt = extension.replace(/[^a-zA-Z0-9.]/g, "").toLowerCase();
  const normalizedExt = safeExt.startsWith(".") ? safeExt : `.${safeExt}`;

  // Generate a unique filename using timestamp + random string
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 10);

  return `${safeFolder}/${timestamp}-${random}${normalizedExt}`;
}
