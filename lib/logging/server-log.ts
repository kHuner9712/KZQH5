// ============================================================
// KZQ Unified Server-Side Logging
//
// Phase 10: All server-side error logging must go through this module.
//
// Contract:
//   - NEVER output error.message, error.stack, or raw error objects.
//   - Use fixed error codes (e.g. INQUIRY_SUBMIT_FAILED) and coarse
//     cause strings (e.g. "network", "rpc-error", "validation").
//   - NEVER log inquiry PII (name, phone, email, wechat, whatsapp,
//     message body), admin account emails, cookies, tokens, or full
//     URL parameters (which may contain utm_* or submission IDs).
//   - Structured format: [STAGE] CODE cause=... [optional sanitized detail]
//
// Usage:
//   import { logServerError } from "@/lib/logging/server-log";
//   logServerError("INQUIRY_SUBMIT_FAILED", "inquiry.submit", "rpc-error");
// ============================================================

/**
 * Coarse cause classifications. These are intentionally vague to avoid
 * leaking internal details. The actual error message is never logged.
 */
export type CoarseCause =
  | "validation"
  | "auth"
  | "permission"
  | "rpc-error"
  | "network"
  | "timeout"
  | "storage"
  | "config"
  | "unknown";

/**
 * Sanitizes a string to ensure it contains no PII or secrets.
 *
 * Strips:
 *   - Email addresses (replaced with [email])
 *   - Phone numbers (replaced with [phone])
 *   - UUIDs (replaced with [uuid]) — inquiry/product IDs are not secrets
 *     but logging them is unnecessary and can correlate to PII
 *   - Bearer tokens / API keys (replaced with [token])
 *   - Long hex strings (replaced with [hash])
 */
function sanitize(value: string): string {
  if (!value) return "";
  let out = value;
  // Order matters: more specific patterns must run before more general ones.
  // UUIDs contain digits and hyphens, so they would be partially matched by
  // the phone-number regex if phone numbers were stripped first. Likewise,
  // Bearer tokens and API keys may contain hex-like substrings that the
  // long-hex regex would catch. So we strip in this order:
  //   1. Bearer tokens / API keys (most specific keyword-prefixed patterns)
  //   2. Emails (contain @, very specific)
  //   3. UUIDs (specific 8-4-4-4-12 hex format with hyphens)
  //   4. Long hex strings (32+ contiguous hex chars)
  //   5. Phone numbers (loose digit+separator pattern — must run last)
  // Bearer tokens
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "[token]");
  // API keys (apikey=... or apikey: ...)
  out = out.replace(/apikey[=:]\s*[A-Za-z0-9._-]+/gi, "[token]");
  // Email addresses
  out = out.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[email]");
  // UUIDs
  out = out.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "[uuid]",
  );
  // Long hex strings (32+ chars — likely hashes or keys)
  out = out.replace(/[0-9a-f]{32,}/gi, "[hash]");
  // Phone numbers (international and domestic formats) — must run AFTER UUIDs
  // because UUIDs contain digits and hyphens that this regex would match.
  out = out.replace(/\+?\d[\d\s\-()]{7,}/g, "[phone]");
  return out;
}

/**
 * Logs a server-side error with a fixed error code and coarse cause.
 *
 * @param code - Fixed error code (e.g. "INQUIRY_SUBMIT_FAILED")
 * @param stage - Processing stage (e.g. "inquiry.submit", "admin.guard")
 * @param cause - Coarse cause classification
 * @param detail - Optional sanitized detail; will be run through sanitize()
 *                 to strip any accidental PII. Keep this short and non-sensitive.
 */
export function logServerError(
  code: string,
  stage: string,
  cause: CoarseCause = "unknown",
  detail?: string,
): void {
  const sanitizedDetail = detail ? sanitize(detail) : "";
  const detailPart = sanitizedDetail ? ` detail="${sanitizedDetail}"` : "";
  // Use console.error so it appears in server logs (EdgeOne/Node).
  // The format is intentionally structured for log aggregation.
  console.error(`[${stage}] ${code} cause=${cause}${detailPart}`);
}

/**
 * Logs an informational server-side message with a fixed code.
 * Used for non-error events (e.g. outbox processing, migration applied).
 */
export function logServerInfo(
  code: string,
  stage: string,
  detail?: string,
): void {
  const sanitizedDetail = detail ? sanitize(detail) : "";
  const detailPart = sanitizedDetail ? ` detail="${sanitizedDetail}"` : "";
  console.log(`[${stage}] ${code}${detailPart}`);
}
