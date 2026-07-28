import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Phase 9: Verify next.config.mjs images.remotePatterns stays
// in sync with lib/validation/url.ts media allowlist.
//
// Both must derive allowed hosts from the same env vars:
//   - NEXT_PUBLIC_SUPABASE_URL  → exact project hostname
//   - MEDIA_CDN_DOMAINS         → comma-separated CDN hostnames
//
// This test prevents drift: if someone adds a host to the validator
// but forgets next.config (or vice versa), this test fails.
// ============================================================

interface RemotePattern {
  protocol: string;
  hostname: string;
}

async function loadPatterns(): Promise<RemotePattern[]> {
  const mod = await import("../../next.config.mjs");
  const config = mod.default as {
    images?: { remotePatterns?: RemotePattern[] };
  };
  return config.images?.remotePatterns ?? [];
}

describe("next.config.mjs images.remotePatterns", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("includes exact Supabase project host (not wildcard)", async () => {
    // Work Package G: Supabase host must be a canonical 20-char project ref.
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      "https://abcdefghijklmnopqrst.supabase.co",
    );
    vi.stubEnv("MEDIA_CDN_DOMAINS", "");
    const patterns = await loadPatterns();
    const hostnames = patterns.map((p) => p.hostname);
    expect(hostnames).toContain("abcdefghijklmnopqrst.supabase.co");
    // Must NOT contain the wildcard when a specific project is configured
    expect(hostnames).not.toContain("**.supabase.co");
  });

  it("includes CDN domains from MEDIA_CDN_DOMAINS", async () => {
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      "https://abcdefghijklmnopqrst.supabase.co",
    );
    vi.stubEnv("MEDIA_CDN_DOMAINS", "cdn.kzq.example.com,cdn2.kzq.example.com");
    const patterns = await loadPatterns();
    const hostnames = patterns.map((p) => p.hostname);
    expect(hostnames).toContain("abcdefghijklmnopqrst.supabase.co");
    expect(hostnames).toContain("cdn.kzq.example.com");
    expect(hostnames).toContain("cdn2.kzq.example.com");
  });

  it("falls back to wildcard only when no env vars are set (local dev)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("MEDIA_CDN_DOMAINS", "");
    const patterns = await loadPatterns();
    const hostnames = patterns.map((p) => p.hostname);
    expect(hostnames).toEqual(["**.supabase.co"]);
  });

  it("ignores placeholder Supabase URLs", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("MEDIA_CDN_DOMAINS", "");
    const patterns = await loadPatterns();
    const hostnames = patterns.map((p) => p.hostname);
    // Placeholder URL should not produce a pattern; fallback to wildcard
    expect(hostnames).not.toContain("example.supabase.co");
    expect(hostnames).toContain("**.supabase.co");
  });

  it("all patterns use HTTPS protocol", async () => {
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      "https://abcdefghijklmnopqrst.supabase.co",
    );
    vi.stubEnv("MEDIA_CDN_DOMAINS", "cdn.kzq.example.com");
    const patterns = await loadPatterns();
    for (const p of patterns) {
      expect(p.protocol).toBe("https");
    }
  });

  it("stays in sync with lib/validation/url.ts allowlist", async () => {
    // This is the critical consistency test: the hosts that the URL validator
    // accepts must be exactly the hosts that next/image will optimize.
    // Work Package G: Supabase host must be a canonical 20-char project ref.
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      "https://abcdefghijklmnopqrst.supabase.co",
    );
    vi.stubEnv("MEDIA_CDN_DOMAINS", "cdn.kzq.example.com");

    const { mediaAllowlistFromEnv, getSupabaseHost, validateMediaUrl } =
      await import("@/lib/validation/url");
    const allowlist = mediaAllowlistFromEnv(process.env);

    const patterns = await loadPatterns();
    const patternHosts = patterns.map((p) => p.hostname);

    // The Supabase host from the validator must be in remotePatterns
    const supabaseHost = getSupabaseHost(allowlist);
    expect(supabaseHost).toBe("abcdefghijklmnopqrst.supabase.co");
    expect(patternHosts).toContain(supabaseHost);

    // A URL the validator accepts must also be in remotePatterns
    const acceptedUrl = "https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/img/test.jpg";
    const validation = validateMediaUrl(acceptedUrl, allowlist);
    expect(validation.ok).toBe(true);
    const acceptedHost = new URL(acceptedUrl).hostname;
    expect(patternHosts).toContain(acceptedHost);

    // A URL the validator rejects (different supabase project) must NOT
    // be in remotePatterns. The reject reason is "unapproved-host" because
    // the host is not the configured Supabase project host and is not in
    // the CDN allowlist.
    const rejectedUrl = "https://evilproject.supabase.co/storage/v1/object/public/img/test.jpg";
    const rejection = validateMediaUrl(rejectedUrl, allowlist);
    expect(rejection.ok).toBe(false);
    expect(rejection.reason).toBe("unapproved-host");
    const rejectedHost = new URL(rejectedUrl).hostname;
    expect(patternHosts).not.toContain(rejectedHost);
  });

  it("Work Package G: rejects non-canonical Supabase host in production", async () => {
    // A Supabase URL whose host is not <20-char-ref>.supabase.co must be
    // rejected at config-build time in production (fail-closed). In dev
    // mode the host is skipped with a warning, falling back to wildcard
    // only when no other patterns are configured.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://bad.supabase.co");
    vi.stubEnv("MEDIA_CDN_DOMAINS", "cdn.kzq.example.com");
    await expect(loadPatterns()).rejects.toThrow(
      /not a canonical Supabase project host/,
    );
  });

  it("Work Package G: rejects invalid MEDIA_CDN_DOMAINS entries in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      "https://abcdefghijklmnopqrst.supabase.co",
    );
    // Invalid entry: contains a port (which is rejected by validateCdnDomainEntry).
    vi.stubEnv("MEDIA_CDN_DOMAINS", "cdn.kzq.example.com:8443");
    await expect(loadPatterns()).rejects.toThrow(
      /invalid MEDIA_CDN_DOMAINS entry/,
    );
  });

  it("Work Package G: production fails-closed when no media hosts are configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("MEDIA_CDN_DOMAINS", "");
    await expect(loadPatterns()).rejects.toThrow(
      /no image remotePatterns configured/,
    );
  });

  // ============================================================
  // Review #3 WP5: BUILD_MOCK_BACKEND restriction tests.
  //
  // BUILD_MOCK_BACKEND=true is only allowed when ALL THREE conditions
  // are met:
  //   1. process.env.CI === "true"
  //   2. process.env.BUILD_MOCK_BACKEND === "true"
  //   3. NEXT_PUBLIC_SUPABASE_URL hostname is "localhost" or "127.0.0.1"
  //
  // If BUILD_MOCK_BACKEND=true is set without the other two conditions,
  // the build fails immediately. This prevents the mock-backend bypass
  // from being used in a real deployment environment or against a real
  // Supabase server.
  // ============================================================
  it("Review #3 WP5: BUILD_MOCK_BACKEND=true without CI fails the build", async () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("BUILD_MOCK_BACKEND", "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:5433");
    vi.stubEnv("MEDIA_CDN_DOMAINS", "");
    await expect(loadPatterns()).rejects.toThrow(
      /BUILD_MOCK_BACKEND=true is only allowed in CI/,
    );
  });

  it("Review #3 WP5: BUILD_MOCK_BACKEND=true with CI but non-loopback Supabase URL fails", async () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("BUILD_MOCK_BACKEND", "true");
    // Real Supabase URL, not a loopback mock server.
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      "https://abcdefghijklmnopqrst.supabase.co",
    );
    vi.stubEnv("MEDIA_CDN_DOMAINS", "");
    await expect(loadPatterns()).rejects.toThrow(
      /BUILD_MOCK_BACKEND=true requires NEXT_PUBLIC_SUPABASE_URL to point at a loopback hostname/,
    );
  });

  it("Review #3 WP5: BUILD_MOCK_BACKEND=true with CI and loopback Supabase URL succeeds", async () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("BUILD_MOCK_BACKEND", "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:5433");
    vi.stubEnv("MEDIA_CDN_DOMAINS", "");
    // Should not throw — the mock backend is allowed in CI with loopback.
    const patterns = await loadPatterns();
    // The localhost mock server should be in the patterns.
    const hostnames = patterns.map((p) => p.hostname);
    expect(hostnames).toContain("127.0.0.1");
  });

  it("Review #3 WP5: BUILD_MOCK_BACKEND=true with CI and localhost hostname succeeds", async () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("BUILD_MOCK_BACKEND", "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:5433");
    vi.stubEnv("MEDIA_CDN_DOMAINS", "");
    // Should not throw — the mock backend is allowed in CI with loopback.
    const patterns = await loadPatterns();
    const hostnames = patterns.map((p) => p.hostname);
    expect(hostnames).toContain("localhost");
  });

  it("Review #3 WP5: BUILD_MOCK_BACKEND=false never fails the build", async () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("BUILD_MOCK_BACKEND", "false");
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      "https://abcdefghijklmnopqrst.supabase.co",
    );
    vi.stubEnv("MEDIA_CDN_DOMAINS", "");
    // Should not throw — BUILD_MOCK_BACKEND is false, so the restriction
    // does not apply.
    const patterns = await loadPatterns();
    const hostnames = patterns.map((p) => p.hostname);
    expect(hostnames).toContain("abcdefghijklmnopqrst.supabase.co");
  });

  it("Review #3 WP5: BUILD_MOCK_BACKEND=true with missing Supabase URL fails", async () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("BUILD_MOCK_BACKEND", "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("MEDIA_CDN_DOMAINS", "");
    await expect(loadPatterns()).rejects.toThrow(
      /BUILD_MOCK_BACKEND=true requires NEXT_PUBLIC_SUPABASE_URL to point at a loopback hostname/,
    );
  });
});
