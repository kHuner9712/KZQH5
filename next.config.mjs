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
// If neither env var is set at build time (e.g. local dev without
// a .env file), we fall back to `**.supabase.co` so that local
// development against a personal Supabase project still works.
// Production builds MUST set NEXT_PUBLIC_SUPABASE_URL; the
// release-readiness script enforces this.
// ============================================================

/**
 * Builds the Next.js image remotePatterns from the same env vars
 * that lib/validation/url.ts uses. Returns an array of pattern
 * objects suitable for `nextConfig.images.remotePatterns`.
 */
function buildImageRemotePatterns() {
  const patterns = [];
  const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const cdnRaw = (process.env.MEDIA_CDN_DOMAINS || "").trim();

  // 1. Exact Supabase project host (e.g. abcdefgh.supabase.co)
  if (supabaseUrl) {
    try {
      const host = new URL(supabaseUrl).hostname.toLowerCase();
      if (host && !host.startsWith("example.") && !host.startsWith("placeholder.")) {
        patterns.push({ protocol: "https", hostname: host });
      }
    } catch {
      // Malformed NEXT_PUBLIC_SUPABASE_URL — skip; release-readiness will flag it.
    }
  }

  // 2. Enterprise CDN domains (comma-separated)
  if (cdnRaw) {
    for (const raw of cdnRaw.split(",")) {
      const domain = raw.trim().toLowerCase();
      if (!domain) continue;
      patterns.push({ protocol: "https", hostname: domain });
    }
  }

  // 3. Fallback for local dev only: if no Supabase URL is configured,
  //    allow any supabase.co subdomain so `next/image` works against
  //    a developer's personal project. This fallback is NEVER active
  //    in production because release-readiness requires the env var.
  if (patterns.length === 0) {
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
