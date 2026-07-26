/**
 * Shared media URL validator (Phase 9 contract, reused by Phase 2 CMS saves).
 *
 * Accepts:
 *   - HTTPS absolute URLs whose host is the configured Supabase Storage
 *     origin or an explicitly approved enterprise CDN domain.
 *   - Same-origin relative paths starting with a single "/" (not "//").
 *
 * Rejects:
 *   - protocol-relative URLs (//host/...)
 *   - javascript:, data:, blob:, file:, ftp:, ws:, wss: schemes
 *   - public HTTP (non-loopback)
 *   - URLs carrying username/password credentials
 *   - non-standard ports (only 443 for https, 80 for loopback http)
 *   - unknown hosts
 *
 * The allowlist is derived from the same configuration that feeds
 * next.config.remotePatterns, so CMS validation and the Next.js image
 * optimizer share one source of truth.
 */

export interface MediaUrlAllowlist {
  /** Supabase project URL, e.g. https://abcdefgh.supabase.co */
  supabaseUrl: string | null;
  /** Comma-separated enterprise CDN domains, e.g. cdn.kzq.example.com */
  cdnDomains: readonly string[];
}

const BLOCKED_SCHEMES = new Set([
  "javascript:",
  "data:",
  "blob:",
  "file:",
  "ftp:",
  "ws:",
  "wss:",
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function mediaAllowlistFromEnv(env: NodeJS.ProcessEnv): MediaUrlAllowlist {
  const supabaseUrl = (env.NEXT_PUBLIC_SUPABASE_URL || "").trim() || null;
  const cdnRaw = (env.MEDIA_CDN_DOMAINS || "").trim();
  const cdnDomains = cdnRaw
    ? cdnRaw
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d.length > 0)
    : [];
  return { supabaseUrl, cdnDomains };
}

export function getSupabaseHost(allowlist: MediaUrlAllowlist): string | null {
  if (!allowlist.supabaseUrl) return null;
  try {
    return new URL(allowlist.supabaseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export interface MediaUrlValidation {
  ok: boolean;
  /** Safe to persist normalized value (the original trimmed string). */
  value?: string;
  reason?:
    | "empty"
    | "blocked-scheme"
    | "protocol-relative"
    | "public-http"
    | "credentials"
    | "unapproved-host"
    | "unapproved-port"
    | "malformed";
}

/**
 * Validate a single media URL string. Empty/whitespace values are rejected
 * with reason "empty" so callers can distinguish "not provided" from
 * "invalid" if they treat the field as optional.
 */
export function validateMediaUrl(
  input: string | null | undefined,
  allowlist: MediaUrlAllowlist,
): MediaUrlValidation {
  if (input == null) return { ok: false, reason: "empty" };
  const value = input.trim();
  if (value.length === 0) return { ok: false, reason: "empty" };

  // Relative same-origin path: must start with a single "/", never "//".
  if (value.startsWith("/")) {
    if (value.startsWith("//")) {
      return { ok: false, reason: "protocol-relative" };
    }
    return { ok: true, value };
  }

  // Reject any blocked scheme by its prefix (case-insensitive).
  const lower = value.toLowerCase();
  for (const scheme of BLOCKED_SCHEMES) {
    if (lower.startsWith(scheme)) {
      return { ok: false, reason: "blocked-scheme" };
    }
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // Reject credentials in the URL.
  if (url.username || url.password) {
    return { ok: false, reason: "credentials" };
  }

  const scheme = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();

  if (scheme === "https:") {
    // Non-default port (not 443) is rejected unless explicitly allowlisted.
    if (url.port && url.port !== "443") {
      return { ok: false, reason: "unapproved-port" };
    }
  } else if (scheme === "http:") {
    // Only loopback http is tolerated (local dev); public HTTP is rejected.
    if (!LOOPBACK_HOSTS.has(host)) {
      return { ok: false, reason: "public-http" };
    }
    if (url.port && url.port !== "80") {
      return { ok: false, reason: "unapproved-port" };
    }
  } else {
    // Any other scheme (ftp, ws, mailto, etc.) is rejected. The blocked
    // list above already caught the dangerous ones; this catches the rest.
    return { ok: false, reason: "blocked-scheme" };
  }

  const supabaseHost = getSupabaseHost(allowlist);
  const approved =
    (supabaseHost !== null && host === supabaseHost) ||
    allowlist.cdnDomains.includes(host) ||
    LOOPBACK_HOSTS.has(host);

  if (!approved) {
    return { ok: false, reason: "unapproved-host" };
  }

  return { ok: true, value };
}

/**
 * Convenience: validate and return the safe value, or null if the field is
 * optional and the input is empty. Throws nothing; caller decides how to
 * surface a non-empty invalid URL.
 */
export function normalizeOptionalMediaUrl(
  input: string | null | undefined,
  allowlist: MediaUrlAllowlist,
): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (input == null) return { ok: true, value: null };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  const result = validateMediaUrl(trimmed, allowlist);
  if (!result.ok) return { ok: false, reason: result.reason ?? "malformed" };
  return { ok: true, value: result.value ?? null };
}
