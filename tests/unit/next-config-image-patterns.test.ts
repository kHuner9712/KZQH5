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
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abcdefgh.supabase.co");
    vi.stubEnv("MEDIA_CDN_DOMAINS", "");
    const patterns = await loadPatterns();
    const hostnames = patterns.map((p) => p.hostname);
    expect(hostnames).toContain("abcdefgh.supabase.co");
    // Must NOT contain the wildcard when a specific project is configured
    expect(hostnames).not.toContain("**.supabase.co");
  });

  it("includes CDN domains from MEDIA_CDN_DOMAINS", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abcdefgh.supabase.co");
    vi.stubEnv("MEDIA_CDN_DOMAINS", "cdn.kzq.example.com,cdn2.kzq.example.com");
    const patterns = await loadPatterns();
    const hostnames = patterns.map((p) => p.hostname);
    expect(hostnames).toContain("abcdefgh.supabase.co");
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
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abcdefgh.supabase.co");
    vi.stubEnv("MEDIA_CDN_DOMAINS", "cdn.kzq.example.com");
    const patterns = await loadPatterns();
    for (const p of patterns) {
      expect(p.protocol).toBe("https");
    }
  });

  it("stays in sync with lib/validation/url.ts allowlist", async () => {
    // This is the critical consistency test: the hosts that the URL validator
    // accepts must be exactly the hosts that next/image will optimize.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://myproject.supabase.co");
    vi.stubEnv("MEDIA_CDN_DOMAINS", "cdn.kzq.example.com");

    const { mediaAllowlistFromEnv, getSupabaseHost, validateMediaUrl } =
      await import("@/lib/validation/url");
    const allowlist = mediaAllowlistFromEnv(process.env);

    const patterns = await loadPatterns();
    const patternHosts = patterns.map((p) => p.hostname);

    // The Supabase host from the validator must be in remotePatterns
    const supabaseHost = getSupabaseHost(allowlist);
    expect(supabaseHost).toBe("myproject.supabase.co");
    expect(patternHosts).toContain(supabaseHost);

    // A URL the validator accepts must also be in remotePatterns
    const acceptedUrl = "https://myproject.supabase.co/storage/v1/object/public/img/test.jpg";
    const validation = validateMediaUrl(acceptedUrl, allowlist);
    expect(validation.ok).toBe(true);
    const acceptedHost = new URL(acceptedUrl).hostname;
    expect(patternHosts).toContain(acceptedHost);

    // A URL the validator rejects (different supabase project) must NOT
    // be in remotePatterns
    const rejectedUrl = "https://evilproject.supabase.co/storage/v1/object/public/img/test.jpg";
    const rejection = validateMediaUrl(rejectedUrl, allowlist);
    expect(rejection.ok).toBe(false);
    expect(rejection.reason).toBe("unapproved-host");
    const rejectedHost = new URL(rejectedUrl).hostname;
    expect(patternHosts).not.toContain(rejectedHost);
  });
});
