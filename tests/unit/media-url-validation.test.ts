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
