import { describe, expect, it } from "vitest";

// ============================================================
// Work Package G: media URL validator security contract
//
// Locks in the deny-list for relative paths and the Supabase host
// shape validation. These are the security-critical behaviors that
// prevent SSRF via the Next.js image optimizer.
// ============================================================

import {
  mediaAllowlistFromEnv,
  validateMediaUrl,
} from "@/lib/validation/url";

const VALID_PROJECT_REF = "abcdefghijklmnopqrst"; // 20 lowercase chars
const VALID_SUPABASE_URL = `https://${VALID_PROJECT_REF}.supabase.co`;

function makeAllowlist(env: Record<string, string | undefined> = {}) {
  return mediaAllowlistFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: VALID_SUPABASE_URL,
    MEDIA_CDN_DOMAINS: "",
    ...env,
  } as unknown as NodeJS.ProcessEnv);
}

describe("validateMediaUrl: relative path deny-list (SSRF prevention)", () => {
  const allowlist = makeAllowlist();

  // --- Denied: internal endpoint prefixes ---
  const deniedInternalPaths = [
    "/api/admin/users",
    "/api/internal/outbox/dispatch",
    "/api/readiness",
    "/admin/products",
    "/admin/dashboard",
    "/_next/static/chunks/main.js",
    "/_next/data/build-id/products.json",
    "/auth/callback",
    "/auth/login",
    "/storage/v1/object/public/secret.pdf",
    "/storage/v1/bucket/private",
  ];

  for (const path of deniedInternalPaths) {
    it(`denies internal path: ${path}`, () => {
      const result = validateMediaUrl(path, allowlist);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("unapproved-relative-path");
    });
  }

  // --- Denied: dot-file paths (never media) ---
  const deniedDotPaths = [
    "/.env",
    "/.git/config",
    "/.well-known/security.txt",
    "/.htaccess",
  ];

  for (const path of deniedDotPaths) {
    it(`denies dot-file path: ${path}`, () => {
      const result = validateMediaUrl(path, allowlist);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("unapproved-relative-path");
    });
  }

  // --- Denied: protocol-relative URLs ---
  it("denies protocol-relative URLs", () => {
    const result = validateMediaUrl("//evil.example.com/x.png", allowlist);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("protocol-relative");
  });

  // --- Allowed: legitimate media directories ---
  const allowedMediaPaths = [
    "/assets/img/test.jpg",
    "/uploads/products/cover.png",
    "/demo/catalogs/kzq-color-card.svg",
    "/kzq-home/category-decorative.jpg",
    "/images/product/test.jpg",
    "/img/0.jpg",
    "/documents/brochure.pdf",
    "/covers/color-card-2026.jpg",
    "/certs/iso.svg",
  ];

  for (const path of allowedMediaPaths) {
    it(`allows media path: ${path}`, () => {
      const result = validateMediaUrl(path, allowlist);
      expect(result.ok).toBe(true);
      expect(result.value).toBe(path);
    });
  }

  // ============================================================
  // Review #2 — Work Package F: bypass attempts.
  //
  // The previous implementation used `value.startsWith(prefix)` on
  // the raw input string, which was vulnerable to bypass via URL
  // encoding, path traversal, backslash separators, double slashes,
  // and missing trailing slashes. The new implementation parses
  // the relative URL against a fixed same-origin base, decodes the
  // pathname, normalizes path segments, and applies a positive
  // whitelist of public media root directories.
  // ============================================================
  const bypassAttempts = [
    // Bare internal roots without trailing slash — the old check
    // was `startsWith("/api/")` which missed `/api`.
    "/api",
    "/admin",
    // Path traversal from a whitelisted root.
    "/assets/../api/readiness",
    // URL-encoded characters that decode to internal paths.
    "/%61pi/readiness", // %61 = 'a' → /api/readiness
    // URL-encoded path traversal.
    "/%2e%2e/api/readiness", // %2e%2e = '..' → /../api/readiness
    "/assets/%2e%2e/api/readiness", // encoded .. inside whitelisted root
    // Backslash separators (Windows path traversal).
    "/assets\\..\\api\\readiness",
    // Double slash — old check caught `//` (protocol-relative) but
    // `//api/readiness` would still be caught here too.
    "//api/readiness",
  ];

  for (const path of bypassAttempts) {
    it(`Review #2 denies bypass attempt: ${path}`, () => {
      const result = validateMediaUrl(path, allowlist);
      expect(result.ok).toBe(false);
      // `//api/readiness` is caught as protocol-relative; all others
      // are caught as unapproved-relative-path.
      expect(result.reason).toMatch(
        /^(protocol-relative|unapproved-relative-path)$/,
      );
    });
  }

  // --- Additional bypass: query/fragment that changes resource semantics ---
  it("Review #2 denies query string with path traversal", () => {
    const result = validateMediaUrl(
      "/assets/img.jpg?path=../../api/readiness",
      allowlist,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-relative-path");
  });

  it("Review #2 denies fragment with path traversal", () => {
    const result = validateMediaUrl(
      "/assets/img.jpg#/../../api/readiness",
      allowlist,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-relative-path");
  });

  it("Review #2 allows simple cache-busting query string", () => {
    const result = validateMediaUrl("/assets/img.jpg?v=123", allowlist);
    expect(result.ok).toBe(true);
    expect(result.value).toBe("/assets/img.jpg?v=123");
  });

  // --- Additional bypass: non-whitelisted root directory ---
  it("Review #2 denies non-whitelisted root directory", () => {
    const result = validateMediaUrl("/internal/img.jpg", allowlist);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-relative-path");
  });

  it("Review #2 denies root-level path (just /)", () => {
    const result = validateMediaUrl("/", allowlist);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-relative-path");
  });

  // ============================================================
  // Review #3 — Work Package 4: double-encoded and split-encoded
  // path traversal bypass attempts.
  //
  // The Review #2 implementation only checked for the literal
  // substrings `%2e`, `%2f`, `%5c`, `%00` in the raw input. Patterns
  // like `/assets/%252e%252e/api/readiness` (double-encoded `%252e`
  // → `%2e` → `.`) and `/assets/%25%32%65/img.jpg` (split-encoded
  // `%25`+`%32`+`%65` → `%2e` → `.`) were NOT caught because the
  // raw input did not contain the literal `%2e` substring.
  //
  // The Review #3 implementation rejects ANY percent-encoding in
  // the pathname portion of the raw input, eliminating an entire
  // class of encoding-based bypasses.
  // ============================================================
  const doubleEncodedBypassAttempts = [
    // Double-encoded path traversal: %252e%252e → %2e%2e → ..
    "/assets/%252e%252e/api/readiness",
    // Double-encoded path separator: %252f → %2f → /
    "/assets/%252fapi%252freadiness",
    // Double-encoded backslash: %255c → %5c → \
    "/assets/%255c..%255capi",
    // Double slashes (URL constructor collapses these silently)
    "/assets//img.jpg",
    // Split-encoded dot: %25 + %32 + %65 → %2e → .
    "/assets/%25%32%65/img.jpg",
    // Single-encoded path traversal (still rejected)
    "/assets/%2e%2e/api/readiness",
    // Single-encoded path separator
    "/assets/%2fapi%252freadiness",
    // Single-encoded backslash
    "/assets/%5c..%5capi",
    // Encoded null byte
    "/assets/%00/img.jpg",
    // Non-ASCII characters (URL constructor would encode to %XX)
    "/assets/文件.jpg",
    // Encoded dot in segment name
    "/assets/img%2Ejpg",
  ];

  for (const path of doubleEncodedBypassAttempts) {
    it(`Review #3 denies encoded bypass attempt: ${path}`, () => {
      const result = validateMediaUrl(path, allowlist);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("unapproved-relative-path");
    });
  }

  // ============================================================
  // Review #3 — Work Package 4: query string restrictions.
  //
  // Only `?v=<alphanumeric short string>` is allowed. All other
  // query parameters, multi-parameter queries, path-like values,
  // and special characters are rejected.
  // ============================================================
  it("Review #3 allows cache-busting query with alphanumeric value", () => {
    const result = validateMediaUrl("/assets/img.jpg?v=abc123", allowlist);
    expect(result.ok).toBe(true);
    expect(result.value).toBe("/assets/img.jpg?v=abc123");
  });

  it("Review #3 allows cache-busting query with hash-style value", () => {
    const result = validateMediaUrl(
      "/assets/img.jpg?v=a1b2c3d4e5f6",
      allowlist,
    );
    expect(result.ok).toBe(true);
    expect(result.value).toBe("/assets/img.jpg?v=a1b2c3d4e5f6");
  });

  it("Review #3 allows cache-busting query with hyphen and underscore", () => {
    const result = validateMediaUrl(
      "/assets/img.jpg?v=abc-123_def",
      allowlist,
    );
    expect(result.ok).toBe(true);
    expect(result.value).toBe("/assets/img.jpg?v=abc-123_def");
  });

  it("Review #3 denies non-v query parameter", () => {
    const result = validateMediaUrl(
      "/assets/img.jpg?path=../../api/readiness",
      allowlist,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-relative-path");
  });

  it("Review #3 denies multi-parameter query", () => {
    const result = validateMediaUrl(
      "/assets/img.jpg?v=123&other=foo",
      allowlist,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-relative-path");
  });

  it("Review #3 denies v parameter with path-like value", () => {
    const result = validateMediaUrl(
      "/assets/img.jpg?v=../../etc/passwd",
      allowlist,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-relative-path");
  });

  it("Review #3 denies v parameter with special characters", () => {
    const result = validateMediaUrl(
      "/assets/img.jpg?v=abc!@#$%^&*()",
      allowlist,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-relative-path");
  });

  it("Review #3 denies v parameter exceeding length cap", () => {
    const longValue = "a".repeat(33);
    const result = validateMediaUrl(
      `/assets/img.jpg?v=${longValue}`,
      allowlist,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-relative-path");
  });

  it("Review #3 denies v parameter with encoded characters", () => {
    const result = validateMediaUrl(
      "/assets/img.jpg?v=%2e%2e",
      allowlist,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-relative-path");
  });

  // ============================================================
  // Review #3 — Work Package 4: fragment rejection.
  //
  // All fragments are rejected. Media URLs never need fragments;
  // their presence is a sign of a bypass attempt or malformed input.
  // ============================================================
  it("Review #3 denies any fragment", () => {
    const result = validateMediaUrl("/assets/img.jpg#section", allowlist);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-relative-path");
  });

  it("Review #3 denies empty fragment", () => {
    const result = validateMediaUrl("/assets/img.jpg#", allowlist);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-relative-path");
  });

  it("Review #3 denies fragment with path traversal", () => {
    const result = validateMediaUrl(
      "/assets/img.jpg#/../../api/readiness",
      allowlist,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-relative-path");
  });

  // ============================================================
  // Review #3 — Work Package 4: canonicalization.
  //
  // The validator must return the CANONICALIZED pathname, not the
  // original input. This ensures non-canonical inputs (e.g. with
  // trailing slashes) are never persisted to the CMS.
  // ============================================================
  it("Review #3 returns canonical pathname (no trailing slash)", () => {
    // Note: trailing slash on a file path is invalid for media; the
    // canonical form is the URL-parsed pathname.
    const result = validateMediaUrl("/assets/img.jpg", allowlist);
    expect(result.ok).toBe(true);
    expect(result.value).toBe("/assets/img.jpg");
  });

  it("Review #3 returns canonical pathname with query", () => {
    const result = validateMediaUrl("/assets/img.jpg?v=abc123", allowlist);
    expect(result.ok).toBe(true);
    expect(result.value).toBe("/assets/img.jpg?v=abc123");
  });

  it("Review #3 does not return original input when it has extra characters", () => {
    // URL with extra whitespace around it should be trimmed and
    // canonicalized.
    const result = validateMediaUrl("  /assets/img.jpg  ", allowlist);
    expect(result.ok).toBe(true);
    expect(result.value).toBe("/assets/img.jpg");
  });
});

// ============================================================
// Phase 1 Task 2: Production must reject loopback media URLs.
//
// localhost, 127.0.0.1, and ::1 are only allowed in development
// and test environments. In production, ALL loopback absolute URLs
// must be rejected (both HTTP and HTTPS) to prevent SSRF and to
// keep the CMS validator in sync with next.config.mjs remotePatterns
// (which already refuses loopback in production).
//
// Bypass attempts that must be caught:
//   - Case variations: LOCALHOST, Localhost
//   - IPv6 bracket forms: [::1]
//   - Trailing dots: localhost. (DNS-equivalent to localhost)
//   - Non-standard ports: localhost:3000
//   - Credentials: user:pass@localhost (already rejected, but verify)
// ============================================================
describe("validateMediaUrl: loopback rejection in production", () => {
  const prodAllowlist = makeAllowlist({ NODE_ENV: "production" });

  const loopbackUrls = [
    "http://localhost/img.jpg",
    "http://127.0.0.1/img.jpg",
    "http://[::1]/img.jpg",
    "https://localhost/img.jpg",
    "https://127.0.0.1/img.jpg",
    "https://[::1]/img.jpg",
    // Case variations
    "http://LOCALHOST/img.jpg",
    "http://LocalHost/img.jpg",
    "http://LOCALhost/img.jpg",
    // Trailing dot (DNS-equivalent)
    "http://localhost./img.jpg",
    "http://127.0.0.1./img.jpg",
    // Non-standard ports
    "http://localhost:3000/img.jpg",
    "http://127.0.0.1:8080/img.jpg",
    "http://[::1]:8080/img.jpg",
    "https://localhost:8443/img.jpg",
  ];

  for (const url of loopbackUrls) {
    it(`rejects loopback URL in production: ${url}`, () => {
      const result = validateMediaUrl(url, prodAllowlist);
      expect(result.ok).toBe(false);
      // The reason must be a host-level rejection, not a scheme/port
      // rejection, so operators can distinguish "loopback not allowed
      // in production" from other config issues.
      expect(result.reason).toBe("unapproved-host");
    });
  }

  it("rejects loopback with credentials in production", () => {
    // Credentials are always rejected, but loopback must also be
    // rejected even if the credential check somehow passes.
    const result = validateMediaUrl(
      "http://user:pass@localhost/img.jpg",
      prodAllowlist,
    );
    expect(result.ok).toBe(false);
    // Credentials take precedence in the current check order.
    expect(result.reason).toBe("credentials");
  });

  it("does NOT break legitimate Supabase URLs in production", () => {
    const result = validateMediaUrl(
      `${VALID_SUPABASE_URL}/storage/v1/object/public/img/test.jpg`,
      prodAllowlist,
    );
    expect(result.ok).toBe(true);
  });

  it("does NOT break legitimate CDN URLs in production", () => {
    const cdnAllowlist = makeAllowlist({
      NODE_ENV: "production",
      MEDIA_CDN_DOMAINS: "cdn.kzq.example.com",
    });
    const result = validateMediaUrl(
      "https://cdn.kzq.example.com/img/test.jpg",
      cdnAllowlist,
    );
    expect(result.ok).toBe(true);
  });
});

describe("validateMediaUrl: loopback allowed in development", () => {
  const devAllowlist = makeAllowlist({ NODE_ENV: "development" });

  it("allows http://localhost in development", () => {
    const result = validateMediaUrl(
      "http://localhost:3000/img.jpg",
      devAllowlist,
    );
    expect(result.ok).toBe(true);
  });

  it("allows http://127.0.0.1 in development", () => {
    const result = validateMediaUrl(
      "http://127.0.0.1:5433/img.jpg",
      devAllowlist,
    );
    expect(result.ok).toBe(true);
  });

  it("allows http://[::1] in development", () => {
    const result = validateMediaUrl("http://[::1]/img.jpg", devAllowlist);
    expect(result.ok).toBe(true);
  });

  it("allows https://localhost in development", () => {
    const result = validateMediaUrl(
      "https://localhost:8443/img.jpg",
      devAllowlist,
    );
    expect(result.ok).toBe(true);
  });
});

describe("validateMediaUrl: loopback allowed in test", () => {
  const testAllowlist = makeAllowlist({ NODE_ENV: "test" });

  it("allows http://localhost in test environment", () => {
    const result = validateMediaUrl("http://localhost/img.jpg", testAllowlist);
    expect(result.ok).toBe(true);
  });

  it("allows http://127.0.0.1 in test environment", () => {
    const result = validateMediaUrl(
      "http://127.0.0.1/img.jpg",
      testAllowlist,
    );
    expect(result.ok).toBe(true);
  });
});

describe("validateMediaUrl: Supabase host shape validation", () => {
  it("accepts canonical 20-char project ref", () => {
    const allowlist = makeAllowlist();
    const result = validateMediaUrl(
      `${VALID_SUPABASE_URL}/storage/v1/object/public/img/test.jpg`,
      allowlist,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects non-canonical Supabase host (too short)", () => {
    const allowlist = makeAllowlist({
      NEXT_PUBLIC_SUPABASE_URL: "https://short.supabase.co",
    });
    const result = validateMediaUrl(
      "https://short.supabase.co/storage/v1/object/public/img/test.jpg",
      allowlist,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-supabase-host");
  });

  it("rejects non-canonical Supabase host (wrong TLD)", () => {
    const allowlist = makeAllowlist({
      NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.net",
    });
    const result = validateMediaUrl(
      "https://abcdefghijklmnopqrst.supabase.net/storage/v1/object/public/img/test.jpg",
      allowlist,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-supabase-host");
  });

  it("rejects a different supabase project than configured", () => {
    const allowlist = makeAllowlist();
    const result = validateMediaUrl(
      "https://zzzzzzzzzzzzzzzzzzzz.supabase.co/storage/v1/object/public/img/test.jpg",
      allowlist,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-host");
  });

  it("accepts explicit CDN domain override", () => {
    const allowlist = makeAllowlist({
      MEDIA_CDN_DOMAINS: "cdn.kzq.example.com",
    });
    const result = validateMediaUrl(
      "https://cdn.kzq.example.com/img/test.jpg",
      allowlist,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects invalid CDN domain entries at allowlist build time", () => {
    // Entries with ports, protocols, paths, or credentials are dropped.
    const allowlist = makeAllowlist({
      MEDIA_CDN_DOMAINS: "cdn.kzq.example.com:8443, https://evil.com, cdn.valid.com",
    });
    expect(allowlist.cdnDomains).toEqual(["cdn.valid.com"]);
  });
});

describe("validateMediaUrl: scheme and credential rejection", () => {
  const allowlist = makeAllowlist();

  const blockedSchemes = [
    "javascript:alert(1)",
    "data:image/png;base64,abc",
    "blob:https://example.com/uuid",
    "file:///etc/passwd",
    "ftp://example.com/file",
    "ws://example.com/socket",
    "wss://example.com/socket",
  ];

  for (const url of blockedSchemes) {
    it(`blocks scheme: ${url.split(":")[0]}`, () => {
      const result = validateMediaUrl(url, allowlist);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("blocked-scheme");
    });
  }

  it("rejects URLs with credentials", () => {
    const result = validateMediaUrl(
      "https://user:pass@abcdefghijklmnopqrst.supabase.co/img/test.jpg",
      allowlist,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("credentials");
  });

  it("rejects public HTTP (non-loopback)", () => {
    const result = validateMediaUrl(
      "http://example.com/img/test.jpg",
      allowlist,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("public-http");
  });

  it("rejects non-default HTTPS port", () => {
    const result = validateMediaUrl(
      "https://abcdefghijklmnopqrst.supabase.co:8443/img/test.jpg",
      allowlist,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unapproved-port");
  });
});
