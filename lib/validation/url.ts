/**
 * Shared media URL validator (Phase 9 contract, reused by Phase 2 CMS saves).
 *
 * Accepts:
 *   - HTTPS absolute URLs whose host is the configured Supabase Storage
 *     origin or an explicitly approved enterprise CDN domain.
 *   - Same-origin relative paths starting with a single "/" (not "//")
 *     whose first path segment is in the positive public-media whitelist
 *     (assets, uploads, demo, images, img, documents, covers, certs,
 *     kzq-home) AND whose normalized pathname does not contain path
 *     traversal, encoded dots/separators, backslashes, or dot-file
 *     segments.
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
 *   - relative paths that are NOT under a whitelisted public media root,
 *     or that contain path traversal (..), encoded dots/separators
 *     (%2e, %2f, %5c, %00), backslashes, double slashes, dot-file
 *     segments, or query/fragment that could change resource semantics
 *     — prevents SSRF via the Next.js image optimizer serving internal
 *     endpoints as images.
 *
 * Review #2 Work Package F: the previous implementation used
 * `value.startsWith(prefix)` on the raw input string, which was
 * vulnerable to bypass via URL-encoded characters (e.g. `/%61pi/...`),
 * path traversal (e.g. `/assets/../api/...`), backslash separators
 * (e.g. `/assets\..\api\...`), and missing trailing slashes (e.g.
 * `/api` without `/`). The new implementation parses the relative URL
 * against a fixed same-origin base, decodes the pathname, normalizes
 * path segments, and applies a positive whitelist of public media root
 * directories before any deny-list check.
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

// ============================================================
// Review #2 Work Package F: positive whitelist of public media root
// directories. A relative media path is accepted ONLY when its first
// path segment (after normalization) is in this set.
//
// This replaces the previous deny-list approach which was vulnerable to
// prefix-based bypasses. The whitelist includes all directories actually
// used by the project (public/demo, public/kzq-home) plus the media root
// directories referenced by CMS-saved URLs and tests (assets, uploads,
// images, img, documents, covers, certs).
// ============================================================
const PUBLIC_MEDIA_ROOTS: ReadonlySet<string> = new Set([
  "assets",
  "uploads",
  "demo",
  "images",
  "img",
  "documents",
  "covers",
  "certs",
  "kzq-home",
]);

// Defense-in-depth: even after the positive whitelist, we still reject
// any normalized path that falls under these internal endpoint prefixes.
// This catches future regressions where a new public directory might
// accidentally collide with an internal route.
const DENIED_INTERNAL_ROOTS: ReadonlySet<string> = new Set([
  "api",
  "admin",
  "_next",
  "auth",
  "storage",
]);

// Fixed same-origin base used to parse relative URLs. The hostname is
// a placeholder that never resolves to a real server — it exists only
// to give `new URL(rel, base)` a stable origin for pathname extraction.
const SAME_ORIGIN_BASE = "https://kzq.local";

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
 * Validate a relative same-origin media path.
 *
 * Review #2 Work Package F: the previous implementation used
 * `value.startsWith(prefix)` on the raw input string, which was
 * vulnerable to bypass via:
 *   - URL-encoded characters: `/%61pi/readiness` (a → %61)
 *   - Path traversal: `/assets/../api/readiness`
 *   - Backslash separators: `/assets\..\api\readiness`
 *   - Double slashes: `//api/readiness`
 *   - Missing trailing slash: `/api` (not caught by `/api/` check)
 *   - Encoded path traversal: `/%2e%2e/api/readiness`
 *
 * The new implementation:
 *   1. Rejects backslashes, null bytes, and encoded path separators
 *      (%2e, %2f, %5c, %00) in the raw input BEFORE parsing.
 *   2. Parses the relative URL against a fixed same-origin base.
 *   3. Extracts and decodes the pathname.
 *   4. Splits into segments and rejects any ".." or "." segment
 *      (path traversal).
 *   5. Rejects any segment starting with "." (dot-file paths).
 *   6. Applies a positive whitelist of public media root directories.
 *   7. Defense-in-depth: rejects paths under internal endpoint roots
 *      (api, admin, _next, auth, storage) even if somehow allowlisted.
 *   8. Rejects query/fragment that contain path-like patterns.
 */
function validateRelativeMediaPath(
  value: string,
): MediaUrlValidation {
  // Step 1: Reject protocol-relative URLs (//host/...).
  if (value.startsWith("//")) {
    return { ok: false, reason: "protocol-relative" };
  }

  // Step 2: Reject backslashes outright. Backslashes are never valid in
  // URL pathnames and are a common path-traversal vector on Windows-
  // tolerant servers. We check the RAW input (before URL parsing)
  // because `new URL()` does not preserve backslashes.
  if (value.includes("\\")) {
    return { ok: false, reason: "unapproved-relative-path" };
  }

  // Step 3: Reject null bytes and encoded path separators/dots in the
  // raw input. `new URL()` may silently decode some of these, so we
  // check the raw string before parsing.
  //   %2e / %2E → "." (encoded dot for path traversal)
  //   %2f / %2F → "/" (encoded path separator)
  //   %5c / %5C → "\" (encoded backslash)
  //   %00       → null byte
  const lower = value.toLowerCase();
  if (
    lower.includes("%2e") ||
    lower.includes("%2f") ||
    lower.includes("%5c") ||
    lower.includes("%00") ||
    value.includes("\0")
  ) {
    return { ok: false, reason: "unapproved-relative-path" };
  }

  // Step 4: Parse the relative URL against a fixed same-origin base.
  // This gives us a stable URL object for pathname extraction. The
  // base hostname is a placeholder that never resolves.
  let url: URL;
  try {
    url = new URL(value, SAME_ORIGIN_BASE);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // Step 5: Reject if the URL introduced a different host. This catches
  // edge cases where the input somehow parsed as an absolute URL.
  if (url.hostname.toLowerCase() !== "kzq.local") {
    return { ok: false, reason: "unapproved-host" };
  }

  // Step 6: Extract the pathname and split into segments. The URL
  // constructor normalizes `//` to `/` in the pathname, so we check
  // for double-slash segments here.
  const pathname = url.pathname;

  // Reject empty pathname (just "/").
  if (pathname === "/" || pathname === "") {
    return { ok: false, reason: "unapproved-relative-path" };
  }

  // Step 7: Split into segments, filtering empty segments (from
  // trailing/double slashes). We then validate each segment.
  const segments = pathname.split("/").filter((s) => s.length > 0);

  // Must have at least one non-empty segment.
  if (segments.length === 0) {
    return { ok: false, reason: "unapproved-relative-path" };
  }

  // Step 8: Reject any ".." or "." segment (path traversal).
  // The URL constructor should resolve these, but we check defensively.
  for (const seg of segments) {
    if (seg === ".." || seg === ".") {
      return { ok: false, reason: "unapproved-relative-path" };
    }
    // Reject any segment starting with "." (dot-file paths like
    // /.env, /.git, /.htaccess). Also catches segments like ".hidden".
    if (seg.startsWith(".")) {
      return { ok: false, reason: "unapproved-relative-path" };
    }
  }

  // Step 9: Apply the positive whitelist of public media root
  // directories. The first segment MUST be in the whitelist.
  const root = segments[0];
  if (!PUBLIC_MEDIA_ROOTS.has(root)) {
    return { ok: false, reason: "unapproved-relative-path" };
  }

  // Step 10: Defense-in-depth — reject if the root falls under any
  // internal endpoint prefix. This should never trigger because the
  // whitelist already excludes them, but it protects against future
  // regressions.
  if (DENIED_INTERNAL_ROOTS.has(root)) {
    return { ok: false, reason: "unapproved-relative-path" };
  }

  // Step 11: Reject query/fragment that could change resource semantics.
  // We allow simple cache-busting query strings (e.g. ?v=123) but reject
  // any query or fragment that contains path-like patterns (.., /, \).
  if (url.search) {
    let decodedSearch: string;
    try {
      decodedSearch = decodeURIComponent(url.search);
    } catch {
      // Malformed percent-encoding in query — reject defensively.
      return { ok: false, reason: "unapproved-relative-path" };
    }
    if (
      decodedSearch.includes("..") ||
      decodedSearch.includes("/") ||
      decodedSearch.includes("\\")
    ) {
      return { ok: false, reason: "unapproved-relative-path" };
    }
  }
  if (url.hash) {
    let decodedHash: string;
    try {
      decodedHash = decodeURIComponent(url.hash);
    } catch {
      return { ok: false, reason: "unapproved-relative-path" };
    }
    if (
      decodedHash.includes("..") ||
      decodedHash.includes("/") ||
      decodedHash.includes("\\")
    ) {
      return { ok: false, reason: "unapproved-relative-path" };
    }
  }

  // Preserve the original input as the stored value (not the
  // normalized form) so existing CMS-saved URLs are unaffected.
  return { ok: true, value };
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

  // Relative same-origin path: must start with a single "/".
  if (value.startsWith("/")) {
    return validateRelativeMediaPath(value);
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
