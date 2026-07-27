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
// ============================================================

const SUPABASE_PROJECT_HOST_PATTERN = /^[a-z0-9]{20}\.supabase\.co$/;

/**
 * Validate a single MEDIA_CDN_DOMAINS entry. Returns the normalized
 * hostname when valid, null when invalid. Mirrors the validation in
 * lib/validation/url.ts so config and runtime share one rule set.
 */
function validateCdnDomainEntry(raw) {
  const trimmed = (raw || "").trim().toLowerCase();
  if (!trimmed) return null;
  if (/[:/?#@]/.test(trimmed)) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) return null;
  if (trimmed.startsWith("[") || trimmed.endsWith("]")) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed)) return null;
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) return null;
  if (trimmed.includes("..")) return null;
  return trimmed;
}

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

  // 1. Exact Supabase project host (e.g. abcdefgh.supabase.co)
  if (supabaseUrl) {
    try {
      const host = new URL(supabaseUrl).hostname.toLowerCase();
      if (
        host &&
        !host.startsWith("example.") &&
        !host.startsWith("placeholder.") &&
        SUPABASE_PROJECT_HOST_PATTERN.test(host)
      ) {
        patterns.push({ protocol: "https", hostname: host });
      } else if (host && !SUPABASE_PROJECT_HOST_PATTERN.test(host)) {
        // Work Package G: refuse non-project-shaped Supabase hosts at
        // build time. Previously any *.supabase.co host was accepted,
        // which allowed cross-tenant image proxying.
        if (isProduction) {
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
    } catch (e) {
      if (e instanceof Error && /next\.config:/.test(e.message)) throw e;
      // Malformed NEXT_PUBLIC_SUPABASE_URL — skip; release-readiness will flag it.
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
