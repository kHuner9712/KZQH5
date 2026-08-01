// ============================================================
// Phase 9: Single source of truth for allowed media hosts.
//
// The `images.remotePatterns` below MUST stay in sync with the
// runtime URL validator in lib/validation/url.ts. Both derive
// from the same env vars:
//   - NEXT_PUBLIC_SUPABASE_URL  → exact project hostname
//   - MEDIA_CDN_DOMAINS         → comma-separated CDN hostnames
//
// Previously this used a wildcard `**.supabase.co` which would
// allow the Next.js image optimizer to proxy images from ANY
// Supabase project — a SSRF / cross-tenant data risk. The
// validator already rejected unknown hosts, so the optimizer
// was the only loose end.
//
// Work Package G hardening:
//   - In production (NODE_ENV=production), the wildcard fallback is
//     DISABLED. If neither NEXT_PUBLIC_SUPABASE_URL nor MEDIA_CDN_DOMAINS
//     is configured, the image optimizer refuses all remote URLs
//     (fail-closed). The release-readiness script still BLOCKs the
//     deploy, but this prevents a misconfigured production build from
//     silently accepting arbitrary *.supabase.co hosts.
//   - Supabase host shape is validated: must match
//     /^[a-z0-9]{20}\.supabase\.co$/ (canonical project-ref host) or
//     be an explicit MEDIA_CDN_DOMAINS entry. Anything else is rejected
//     at build time (not at runtime when a request arrives).
//   - MEDIA_CDN_DOMAINS entries are validated as hostname-only (no
//     protocol, port, path, or credentials).
//
// In development (NODE_ENV != production), the wildcard fallback
// remains so local dev against a personal Supabase project still works.
//
// Review #2 WP8 build-mock bypass:
//   When BUILD_MOCK_BACKEND=true is set, the canonical host shape
//   check is relaxed so the CI production-contract build can point
//   NEXT_PUBLIC_SUPABASE_URL at a localhost mock server
//   (scripts/mock-supabase-for-build.mjs). This bypass is ONLY
//   available at build time and never affects runtime behavior. The
//   flag must never be set in real deployments — release-readiness
//   still requires a canonical Supabase URL.
//
// Review #3 WP5: BUILD_MOCK_BACKEND=true is now restricted to the
//   CI environment AND a loopback NEXT_PUBLIC_SUPABASE_URL hostname.
//   The previous implementation only checked the flag itself, which
//   allowed a developer or a misconfigured deployment to set
//   BUILD_MOCK_BACKEND=true with a real Supabase URL and silently
//   bypass the canonical host shape check. The new implementation
//   requires ALL THREE conditions:
//     1. process.env.CI === "true"
//     2. process.env.BUILD_MOCK_BACKEND === "true"
//     3. NEXT_PUBLIC_SUPABASE_URL hostname is "localhost" or "127.0.0.1"
//   If BUILD_MOCK_BACKEND=true is set without the other two
//   conditions, the build fails immediately with a clear error.
// ============================================================

// KZQ-P2-003: media host rules now live in ONE place
// (lib/config/media-domains.mjs) shared with lib/validation/url.ts,
// lib/security/csp-policy.ts and scripts/check-release-readiness.mjs.
import {
  SUPABASE_PROJECT_HOST_PATTERN,
  isLoopbackHost,
  parseSupabaseUrl,
  validateCdnDomainEntry,
} from "./lib/config/media-domains.mjs";

const BUILD_MOCK_BACKEND_FLAG = process.env.BUILD_MOCK_BACKEND === "true";
const IS_CI = process.env.CI === "true";

// Review #3 WP5: extract the hostname from NEXT_PUBLIC_SUPABASE_URL
// so we can verify the mock-backend bypass only targets a loopback
// mock server, never a real Supabase project URL.
const PARSED_SUPABASE_URL = parseSupabaseUrl(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
);
const SUPABASE_URL_HOSTNAME = PARSED_SUPABASE_URL?.hostname ?? null;
const IS_LOOPBACK_SUPABASE_HOST =
  SUPABASE_URL_HOSTNAME !== null && isLoopbackHost(SUPABASE_URL_HOSTNAME);

// Review #3 WP5: BUILD_MOCK_BACKEND is only honored when ALL three
// conditions are met. If the flag is set but the environment is not
// CI or the Supabase URL hostname is not loopback, the build fails
// immediately. This prevents the mock-backend bypass from being used
// in a real deployment environment or against a real Supabase server.
if (BUILD_MOCK_BACKEND_FLAG) {
  if (!IS_CI) {
    throw new Error(
      "next.config: BUILD_MOCK_BACKEND=true is only allowed in CI " +
        "(process.env.CI === \"true\"). The current environment is not CI. " +
        "Remove BUILD_MOCK_BACKEND from your environment or set CI=true " +
        "and point NEXT_PUBLIC_SUPABASE_URL at a loopback mock server.",
    );
  }
  if (!IS_LOOPBACK_SUPABASE_HOST) {
    throw new Error(
      "next.config: BUILD_MOCK_BACKEND=true requires " +
        "NEXT_PUBLIC_SUPABASE_URL to point at a loopback hostname " +
        "(localhost/127.0.0.1). The current NEXT_PUBLIC_SUPABASE_URL " +
        `hostname is "${SUPABASE_URL_HOSTNAME ?? "<missing>"}". ` +
        "Remove BUILD_MOCK_BACKEND from your environment or point " +
        "NEXT_PUBLIC_SUPABASE_URL at a loopback mock server.",
    );
  }
}

// The mock-backend bypass is only enabled when all three conditions
// are satisfied. In all other cases BUILD_MOCK_BACKEND_FLAG is
// ignored (and the build would have already failed above if the
// flag was set without CI + loopback).
const BUILD_MOCK_BACKEND =
  BUILD_MOCK_BACKEND_FLAG && IS_CI && IS_LOOPBACK_SUPABASE_HOST;

/**
 * Builds the Next.js image remotePatterns from the same env vars
 * that lib/validation/url.ts uses. Returns an array of pattern
 * objects suitable for `nextConfig.images.remotePatterns`.
 */
function buildImageRemotePatterns() {
  const patterns = [];
  const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const cdnRaw = (process.env.MEDIA_CDN_DOMAINS || "").trim();
  const isProduction = process.env.NODE_ENV === "production";
  // Review #2 WP8: when BUILD_MOCK_BACKEND=true the CI
  // production-contract build points NEXT_PUBLIC_SUPABASE_URL at a
  // localhost mock server. The host shape check is bypassed so the
  // build can complete; the release-readiness script still blocks
  // real deployments that try to use a non-canonical host.
  const allowMockHost = BUILD_MOCK_BACKEND;

  // 1. Exact Supabase project host (e.g. abcdefgh.supabase.co)
  if (supabaseUrl) {
    const parsed = parseSupabaseUrl(supabaseUrl);
    const host = parsed?.hostname ?? null;
    if (host) {
      const protocol = parsed.protocol;
      if (
        !host.startsWith("example.") &&
        !host.startsWith("placeholder.") &&
        SUPABASE_PROJECT_HOST_PATTERN.test(host)
      ) {
        patterns.push({ protocol: "https", hostname: host });
      } else if (allowMockHost && isLoopbackHost(host)) {
        // CI build-mock: accept localhost URLs without the canonical
        // host shape check. The mock server never serves images, so
        // this entry is harmless; it satisfies the no-empty-patterns
        // fail-closed guard below.
        patterns.push({ protocol, hostname: host, port: parsed.port || undefined });
      } else if (!SUPABASE_PROJECT_HOST_PATTERN.test(host)) {
        // Work Package G: refuse non-project-shaped Supabase hosts at
        // build time. Previously any *.supabase.co host was accepted,
        // which allowed cross-tenant image proxying.
        if (isProduction && !allowMockHost) {
          throw new Error(
            `next.config: NEXT_PUBLIC_SUPABASE_URL host "${host}" is not a canonical Supabase project host (expected <project-ref>.supabase.co). ` +
              `Set NEXT_PUBLIC_SUPABASE_URL to your project URL or add an explicit MEDIA_CDN_DOMAINS override.`,
          );
        }
        // Dev: skip but don't fail the build.
        // eslint-disable-next-line no-console
        console.warn(
          `next.config: skipping non-canonical Supabase host "${host}" in dev mode.`,
        );
      }
    }
  }

  // 2. Enterprise CDN domains (comma-separated, validated as hostname-only)
  if (cdnRaw) {
    for (const raw of cdnRaw.split(",")) {
      const domain = validateCdnDomainEntry(raw);
      if (!domain) {
        if (isProduction) {
          throw new Error(
            `next.config: invalid MEDIA_CDN_DOMAINS entry "${raw}". ` +
              `Expected hostname only (no protocol, port, path, or credentials).`,
          );
        }
        continue;
      }
      patterns.push({ protocol: "https", hostname: domain });
    }
  }

  // 3. Fail-closed in production, dev-only wildcard fallback.
  // Previously: any *.supabase.co host was accepted if neither env var was set.
  // Work Package G: in production this is a security hole — refuse to start.
  // In dev, the wildcard remains so local development works.
  if (patterns.length === 0) {
    if (isProduction) {
      throw new Error(
        "next.config: no image remotePatterns configured. " +
          "Set NEXT_PUBLIC_SUPABASE_URL and/or MEDIA_CDN_DOMAINS in production. " +
          "Refusing to enable the wildcard *.supabase.co fallback in production.",
      );
    }
    patterns.push({ protocol: "https", hostname: "**.supabase.co" });
  }

  return patterns;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pdfjs-dist ships ESM that Next.js's default webpack config cannot resolve
  // via deep subpaths (e.g. `pdfjs-dist/legacy/build/pdf.mjs`). Transpiling
  // the package lets webpack bundle the deep import correctly.
  transpilePackages: ["pdfjs-dist"],
  webpack: (config, { isServer }) => {
    // pdfjs-dist references Node built-ins (fs, http, https, url) which we
    // never use in the browser. Mark them as empty modules on the client.
    if (!isServer) {
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        fs: false,
        http: false,
        https: false,
        url: false,
        canvas: false,
        path2d: false,
      };
    }
    return config;
  },
  images: {
    remotePatterns: buildImageRemotePatterns(),
  },
};

export default nextConfig;
