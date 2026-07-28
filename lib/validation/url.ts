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
  /** Captured NODE_ENV at allowlist build time, used to reject loopback
   *  hosts in production while still permitting them in development and
   *  test environments. */
  nodeEnv: string;
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
// Phase 1 Task 2: loopback host detection that resists bypass.
//
// Normalizes the hostname before comparing against LOOPBACK_HOSTS:
//   - lowercases (defensive; callers already lowercase)
//   - strips a single trailing dot (DNS root label: "localhost." ≡ "localhost")
//   - strips IPv6 brackets ("[::1]" → "::1")
//
// This covers the bypass vectors enumerated in the test suite:
//   - Case variations: LOCALHOST, Localhost
//   - Trailing dots: localhost., 127.0.0.1.
//   - IPv6 bracket forms: [::1]
// ============================================================
function isLoopbackHost(host: string): boolean {
  let normalized = host.toLowerCase();
  if (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  return LOOPBACK_HOSTS.has(normalized);
}

function isProductionEnv(nodeEnv: string): boolean {
  return nodeEnv === "production";
}

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
  const nodeEnv = (env.NODE_ENV || "").trim();
  return { supabaseUrl, cdnDomains, nodeEnv };
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
 * Review #3 Work Package 4: the Review #2 implementation still
 * allowed double-encoded and split-encoded path traversal patterns
 * to slip through because it only checked for the literal substrings
 * `%2e`, `%2f`, `%5c`, `%00` in the raw input. Patterns like
 * `/assets/%252e%252e/api/readiness` (double-encoded `%252e` → `%2e`
 * → `.`), `/assets/%25%32%65/img.jpg` (split-encoded `%25`+`%32`+`%65`
 * → `%2e` → `.`) and `/assets/%255c..%255capi` (double-encoded `%255c`
 * → `%5c` → `\`) were NOT caught. The new implementation rejects ANY
 * percent-encoding in the pathname portion outright.
 *
 * The new implementation:
 *   1. Rejects protocol-relative URLs (//host/...).
 *   2. Rejects backslashes, null bytes outright.
 *   3. Rejects ANY percent-encoding in the pathname portion of the
 *      raw input — eliminates an entire class of encoding-based bypass.
 *   4. Parses the relative URL against a fixed same-origin base.
 *   5. Defense-in-depth: decodes the resulting pathname up to two
 *      times and re-checks for path traversal, separators, null
 *      bytes, dot-file segments and internal root prefixes after
 *      each decode pass.
 *   6. Rejects double-slash segments in the pathname.
 *   7. Applies a positive whitelist of public media root directories.
 *   8. Defense-in-depth: rejects paths under internal endpoint roots
 *      (api, admin, _next, auth, storage) even if somehow allowlisted.
 *   9. Restricts query string to exactly `?v=<alphanumeric short
 *      string>` (cache-busting only). Any other query parameter is
 *      rejected.
 *  10. Rejects all fragments. Media URLs never need fragments.
 *  11. Returns the CANONICALIZED pathname (not the original input)
 *      so non-canonical inputs are never persisted.
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

  // Step 3: Reject null bytes in the raw input.
  if (value.includes("\0")) {
    return { ok: false, reason: "unapproved-relative-path" };
  }

  // Step 4: Review #3 WP4 — Reject ANY percent-encoding in the pathname
  // portion of the raw input. Media paths must be plain ASCII filenames
  // (typically slugs or hashes); any `%` in the pathname is a red flag
  // for path traversal bypass attempts:
  //   - Single-encoded: `/%2e%2e/` → `..`
  //   - Double-encoded: `/%252e%252e/` → `%2e%2e` → `..`
  //   - Split-encoded: `/%25%32%65/` → `%2e` → `.`
  //   - Encoded separators: `/%2f/`, `/%5c\`
  // Splitting the raw input on `?` and `#` isolates the pathname so
  // that legitimate query strings (e.g. `?v=abc123`) are unaffected.
  const pathPartOfInput = value.split("?")[0].split("#")[0];
  if (pathPartOfInput.includes("%")) {
    return { ok: false, reason: "unapproved-relative-path" };
  }

  // Step 5: Parse the relative URL against a fixed same-origin base.
  // This gives us a stable URL object for pathname extraction. The
  // base hostname is a placeholder that never resolves.
  let url: URL;
  try {
    url = new URL(value, SAME_ORIGIN_BASE);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // Step 6: Reject if the URL introduced a different host. This catches
  // edge cases where the input somehow parsed as an absolute URL.
  if (url.hostname.toLowerCase() !== "kzq.local") {
    return { ok: false, reason: "unapproved-host" };
  }

  // Step 7: Reject if the URL constructor introduced any percent-
  // encoding into the pathname (e.g. non-ASCII characters in the input
  // like `/assets/文件.jpg` would be encoded to `/assets/%E6%96%87...`).
  // Media paths must be plain ASCII.
  const pathname = url.pathname;
  if (pathname.includes("%")) {
    return { ok: false, reason: "unapproved-relative-path" };
  }

  // Reject empty pathname (just "/").
  if (pathname === "/" || pathname === "") {
    return { ok: false, reason: "unapproved-relative-path" };
  }

  // Step 8: Reject double-slash segments in the pathname. The URL
  // constructor collapses `//` to `/` in the pathname, so we check
  // the raw input's path portion for `//`. This catches
  // `/assets//img.jpg` which would otherwise be silently normalized
  // to `/assets/img.jpg`.
  if (pathPartOfInput.includes("//")) {
    return { ok: false, reason: "unapproved-relative-path" };
  }

  // Step 9: Defense-in-depth — decode the pathname up to two times
  // until the result stabilizes, and after each decode pass re-check
  // for path traversal patterns. This catches edge cases where the
  // URL constructor preserved percent-encoded characters that could
  // be decoded by a downstream consumer.
  let decoded = pathname;
  for (let i = 0; i < 2; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      // Malformed percent-encoding — reject defensively.
      return { ok: false, reason: "unapproved-relative-path" };
    }
    if (next === decoded) break; // stable — no further decoding possible
    // After each decode, check for path traversal, separators, null
    // bytes. These would indicate an encoded bypass attempt.
    if (
      next.includes("..") ||
      next.includes("/") ||
      next.includes("\\") ||
      next.includes("\0")
    ) {
      // `..` after decoding indicates encoded path traversal.
      // `/` or `\` after decoding (beyond the leading slash) indicates
      // an encoded separator that could split segments unexpectedly.
      // Only the leading `/` is safe; any additional decoded separator
      // means the original input had an encoded separator.
      const trimmed = next.startsWith("/") ? next.slice(1) : next;
      if (
        trimmed.includes("/") ||
        trimmed.includes("\\") ||
        next.includes("..") ||
        next.includes("\0")
      ) {
        return { ok: false, reason: "unapproved-relative-path" };
      }
    }
    decoded = next;
  }

  // Step 10: Split into segments, filtering empty segments (from
  // trailing/double slashes). We then validate each segment.
  const segments = pathname.split("/").filter((s) => s.length > 0);

  // Must have at least one non-empty segment.
  if (segments.length === 0) {
    return { ok: false, reason: "unapproved-relative-path" };
  }

  // Step 11: Reject any ".." or "." segment (path traversal).
  // The URL constructor should resolve these, but we check defensively.
  // Also reject any segment starting with "." (dot-file paths like
  // /.env, /.git, /.htaccess). Also catches segments like ".hidden".
  for (const seg of segments) {
    if (seg === ".." || seg === ".") {
      return { ok: false, reason: "unapproved-relative-path" };
    }
    if (seg.startsWith(".")) {
      return { ok: false, reason: "unapproved-relative-path" };
    }
  }

  // Step 12: Apply the positive whitelist of public media root
  // directories. The first segment MUST be in the whitelist.
  const root = segments[0];
  if (!PUBLIC_MEDIA_ROOTS.has(root)) {
    return { ok: false, reason: "unapproved-relative-path" };
  }

  // Step 13: Defense-in-depth — reject if the root falls under any
  // internal endpoint prefix. This should never trigger because the
  // whitelist already excludes them, but it protects against future
  // regressions.
  if (DENIED_INTERNAL_ROOTS.has(root)) {
    return { ok: false, reason: "unapproved-relative-path" };
  }

  // Step 14: Review #3 WP4 — Restrict query string to exactly
  // `?v=<alphanumeric short string>` (cache-busting only). Any other
  // query parameter, multi-parameter queries, or path-like values are
  // rejected. This prevents query-based SSRF (e.g.
  // `?path=../../api/...`) and parameter pollution.
  let canonicalValue = pathname;
  if (url.search) {
    const searchParams = url.searchParams;
    // Must have exactly one parameter named "v".
    if (searchParams.size !== 1 || !searchParams.has("v")) {
      return { ok: false, reason: "unapproved-relative-path" };
    }
    const v = searchParams.get("v");
    // Value must be a short alphanumeric string (with optional hyphen
    // / underscore for hash-style cache busters). Length is capped at
    // 32 chars to prevent abuse.
    if (v == null || !/^[a-zA-Z0-9_-]{1,32}$/.test(v)) {
      return { ok: false, reason: "unapproved-relative-path" };
    }
    canonicalValue += `?v=${v}`;
  }

  // Step 15: Review #3 WP4 — Reject all fragments. Media URLs never
  // need fragments; their presence is a sign of a bypass attempt or
  // a malformed input. Default deny. We check both `url.hash` (for
  // non-empty fragments like `#section`) and the raw input for a `#`
  // character (to catch empty fragments like `/assets/img.jpg#` which
  // `new URL()` treats as no fragment at all).
  if (url.hash || value.includes("#")) {
    return { ok: false, reason: "unapproved-relative-path" };
  }

  // Step 16: Review #3 WP4 — Return the CANONICALIZED pathname, not
  // the original input. This ensures non-canonical inputs (e.g. with
  // trailing slashes, normalized casing, etc.) are never persisted.
  // The canonical form is the URL-parsed pathname plus the optional
  // normalized `?v=<value>` query string.
  return { ok: true, value: canonicalValue };
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
  const isLoopback = isLoopbackHost(host);

  // Phase 1 Task 2: in production, reject ALL loopback absolute URLs
  // regardless of scheme or port. This must run BEFORE the port check
  // so the rejection reason is "unapproved-host" (not "unapproved-port"),
  // letting operators distinguish "loopback not allowed in production"
  // from other configuration issues. This also keeps the CMS validator
  // in sync with next.config.mjs remotePatterns, which already refuses
  // loopback hosts in production.
  if (isProductionEnv(allowlist.nodeEnv) && isLoopback) {
    return { ok: false, reason: "unapproved-host" };
  }

  if (scheme === "https:") {
    // Non-loopback HTTPS must use default port 443. Loopback HTTPS
    // (only reachable in non-production after the check above) may
    // use any port — local dev servers like localhost:8443 are valid.
    if (!isLoopback && url.port && url.port !== "443") {
      return { ok: false, reason: "unapproved-port" };
    }
  } else if (scheme === "http:") {
    // Only loopback http is tolerated (local dev); public HTTP is rejected.
    if (!isLoopback) {
      return { ok: false, reason: "public-http" };
    }
    // Loopback HTTP: any port allowed (production loopback was already
    // rejected above, so this is only reachable in non-production).
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
  } else if (allowlist.cdnDomains.includes(host) || isLoopback) {
    // CDN or loopback (loopback only reachable in non-production).
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
