/**
 * Shared media URL validator (Phase 9 contract, reused by Phase 2 CMS saves).
 *
 * Accepts:
 *   - HTTPS absolute URLs whose host is the configured Supabase Storage
 *     origin or an explicitly approved enterprise CDN domain.
 *   - Same-origin relative paths starting with a single "/" (not "//")
 *     AND NOT falling under a denied internal path prefix
 *     (/api/**, /admin/**, /_next/**, /auth/**, /storage/**, /.**).
 *
 * Rejects:
 *   - protocol-relative URLs (//host/...)
 *   - javascript:, data:, blob:, file:, ftp:, ws:, wss: schemes
 *   - public HTTP (non-loopback)
 *   - URLs carrying username/password credentials
 *   - non-standard ports (only 443 for https, 80 for loopback http)
 *   - unknown hosts
 *   - Supabase URLs that are not project-shaped (<ref>.supabase.co) or
 *     explicitly-overridden enterprise hosts — prevents accidental
 *     wildcarding to arbitrary supabase.co projects.
 *   - relative paths that point at internal endpoints (/api/**, /admin/**,
 *     /_next/**, /auth/**, /storage/**, /.**) — prevents SSRF via the
 *     Next.js image optimizer serving internal endpoints as images.
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

// Work Package G: relative media paths are denied when they fall under
// these internal endpoint prefixes. Anything else (e.g. /api/admin/storage/
// preview/<secret>) would let a CMS-saved "media URL" render internal
// endpoints as <img>/<Image> via the Next.js image optimizer, acting as
// an SSRF oracle.
//
// We use a deny-list (not an allowlist) because the codebase legitimately
// serves media from several public/ subdirectories (demo/, kzq-home/,
// etc.) and CMS-saved URLs may point at any of them. The deny-list is
// comprehensive for known-internal Next.js / Supabase paths.
const DENIED_RELATIVE_PREFIXES = [
  "/api/",
  "/admin/",
  "/_next/",
  "/auth/",
  "/storage/",
] as const;
// Any path whose first segment starts with "." (e.g. "/.env", "/.git",
// "/.well-known/") is also denied — these are never media paths.
const DENIED_DOT_PATH_PATTERN = /^\/\./;

// Supabase project host shape: <project-ref>.supabase.co where
// project-ref is 20 lowercase alphanumeric characters. Anything else
// must be explicitly approved via MEDIA_CDN_DOMAINS.
const SUPABASE_PROJECT_HOST_PATTERN =
  /^[a-z0-9]{20}\.supabase\.co$/;

/**
 * Validate a single MEDIA_CDN_DOMAINS entry. Returns the normalized
 * hostname when valid, null when invalid.
 *
 * Validation rules:
 *   - hostname only (no protocol, port, path, query, credentials)
 *   - must be a valid DNS name (letters, digits, hyphens, dots)
 *   - must NOT be an IP literal
 *   - must NOT be a bare TLD (".com", "supabase.co")
 */
function validateCdnDomainEntry(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  // Reject anything that looks like a URL (protocol, port, path, query).
  if (/[:/?#@]/.test(trimmed)) return null;
  // Reject bare IPs.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) return null;
  // Reject IPv6 / bracketed hosts.
  if (trimmed.startsWith("[") || trimmed.endsWith("]")) return null;
  // Must contain at least one dot and be a valid DNS name.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed)) return null;
  // Reject all-segments-empty or leading/trailing dot.
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) return null;
  // Reject ".." sequences.
  if (trimmed.includes("..")) return null;
  return trimmed;
}

export function mediaAllowlistFromEnv(env: NodeJS.ProcessEnv): MediaUrlAllowlist {
  const supabaseUrl = (env.NEXT_PUBLIC_SUPABASE_URL || "").trim() || null;
  const cdnRaw = (env.MEDIA_CDN_DOMAINS || "").trim();
  const cdnDomains = cdnRaw
    ? cdnRaw
        .split(",")
        .map((d) => validateCdnDomainEntry(d))
        .filter((d): d is string => d !== null)
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
    | "unapproved-supabase-host"
    | "unapproved-relative-path"
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

  // Relative same-origin path: must start with a single "/", never "//",
  // AND must NOT fall under a denied internal path prefix.
  if (value.startsWith("/")) {
    if (value.startsWith("//")) {
      return { ok: false, reason: "protocol-relative" };
    }
    // Work Package G: deny internal endpoint prefixes to prevent SSRF via
    // the Next.js image optimizer. /api/**, /admin/**, /_next/**, /auth/**,
    // /storage/**, and any dot-file path would otherwise be accepted as
    // media URLs and rendered as <Image> — an SSRF vector that could leak
    // internal responses via the optimizer's fetch behavior.
    if (DENIED_DOT_PATH_PATTERN.test(value)) {
      return { ok: false, reason: "unapproved-relative-path" };
    }
    const isDeniedInternalPath = DENIED_RELATIVE_PREFIXES.some((prefix) =>
      value.startsWith(prefix),
    );
    if (isDeniedInternalPath) {
      return { ok: false, reason: "unapproved-relative-path" };
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

  // Work Package G: validate Supabase host shape. A Next.js image
  // optimizer pattern that points at an arbitrary supabase.co project
  // (e.g. evil.supabase.co) is an SSRF / cross-tenant data risk. We
  // only accept the canonical project-ref shape OR a project that
  // matches MEDIA_CDN_DOMAINS (enterprise override).
  if (supabaseHost && host === supabaseHost) {
    if (!SUPABASE_PROJECT_HOST_PATTERN.test(host)) {
      return { ok: false, reason: "unapproved-supabase-host" };
    }
  } else if (allowlist.cdnDomains.includes(host) || LOOPBACK_HOSTS.has(host)) {
    // CDN or loopback — already validated by mediaAllowlistFromEnv.
  } else {
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
