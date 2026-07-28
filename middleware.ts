// ============================================================
// KZQ Security + Auth Session Middleware
//
// Phase 10: Adds security headers to all responses.
// Phase WP-C: Refreshes Supabase Auth sessions on auth-aware paths.
// Work Package G: CSP tightened — precise Supabase host instead of
//   *.supabase.co wildcard, img-src allowlist instead of bare "https:",
//   explicit object-src 'none' / frame-src 'none' / upgrade-insecure-
//   requests, optional enforcing mode via CSP_ENFORCING env var.
//
// Headers applied:
//   - X-Content-Type-Options: nosniff
//   - Referrer-Policy: strict-origin-when-cross-origin
//   - Permissions-Policy: restrictive (no camera, mic, geo, payment)
//   - X-Frame-Options: DENY (clickjacking protection)
//   - Strict-Transport-Security: max-age=31536000; includeSubDomains
//     (only on HTTPS — HSTS over HTTP is ignored by browsers and can
//     cause issues during local development)
//   - Content-Security-Policy-Report-Only (default) OR
//     Content-Security-Policy (when CSP_ENFORCING=true). The policy
//     allows Supabase, Next.js internals, PDF.js worker, and WeChat
//     JS-SDK. Report-Only mode logs violations without blocking.
//
// Session refresh:
//   - On /admin/**, /api/admin/**, /api/internal/** paths, the middleware
//     calls supabase.auth.getUser() to trigger @supabase/ssr's auto-refresh
//     logic. Refreshed cookies are written to BOTH the request and the
//     response returned by refreshSupabaseSession().
//   - When any auth cookie is rotated, the returned response carries
//     `Cache-Control: private, no-store` so shared caches cannot serve
//     a session-bound response to a different user. All security headers
//     set on this response are preserved on the returned response.
//   - The middleware does NOT use the session for authorization — that is
//     the exclusive job of getVerifiedAdmin() server-side. This module only
//     refreshes cookies.
//   - Failures during refresh do NOT block the request.
//
// ISR safety:
//   - Session refresh is ONLY triggered on auth-aware paths. Public ISR
//     pages never have their auth cookies read, so they remain statically
//     cached.
//   - Security headers are added to ALL responses (cheap, no cookie access).
//   - The middleware matcher excludes static assets (_next/static, images,
//     favicon) so they are served without overhead.
// ============================================================

import { NextResponse, type NextRequest } from "next/server";
import {
  refreshSupabaseSession,
  shouldRefreshSession,
} from "@/lib/supabase/middleware-session";

const SUPABASE_PROJECT_HOST_PATTERN = /^[a-z0-9]{20}\.supabase\.co$/;

/**
 * Resolve the precise Supabase project host from env at module load.
 *
 * Falls back to "*.supabase.co" ONLY in non-production dev mode. In
 * production we refuse to fall back — if the env is missing or
 * malformed, the connect-src directive falls back to 'self' only,
 * which will break Supabase calls but is the safe choice (fail-closed).
 * Release-readiness still BLOCKs the deploy for missing env.
 */
function resolveSupabaseCspHost(): string {
  const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  if (supabaseUrl) {
    try {
      const host = new URL(supabaseUrl).hostname.toLowerCase();
      if (SUPABASE_PROJECT_HOST_PATTERN.test(host)) {
        return `https://${host}`;
      }
    } catch {
      // fall through
    }
  }
  if (process.env.NODE_ENV === "production") {
    // Fail-closed: only allow same-origin in production when the env is
    // missing/malformed. Supabase calls will break but no cross-tenant
    // exfiltration is possible.
    return "'self'";
  }
  // Dev fallback: allow any supabase.co subdomain so local dev still works.
  return "https://*.supabase.co";
}

/**
 * Resolve the MEDIA_CDN_DOMAINS allowlist for img-src / connect-src.
 * Returns a CSP fragment string (e.g. "https://cdn1.example.com https://cdn2.example.com")
 * or empty string when no CDN domains are configured.
 */
function resolveCdnCspHosts(): string {
  const cdnRaw = (process.env.MEDIA_CDN_DOMAINS || "").trim();
  if (!cdnRaw) return "";
  const hosts: string[] = [];
  for (const raw of cdnRaw.split(",")) {
    const trimmed = raw.trim().toLowerCase();
    // Reuse the same hostname-only validation as next.config.mjs / url.ts.
    if (
      trimmed &&
      !/[:/?#@]/.test(trimmed) &&
      !/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed) &&
      !trimmed.startsWith("[") &&
      !trimmed.endsWith("]") &&
      /^[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed) &&
      !trimmed.startsWith(".") &&
      !trimmed.endsWith(".") &&
      !trimmed.includes("..")
    ) {
      hosts.push(`https://${trimmed}`);
    }
  }
  return hosts.join(" ");
}

const supabaseCspHost = resolveSupabaseCspHost();
const cdnCspHosts = resolveCdnCspHosts();

/**
 * Build the img-src directive from the Supabase host + CDN allowlist.
 *
 * Previously this was "img-src 'self' data: blob: https:" which allowed
 * ANY HTTPS image host. Work Package G: replaced with an explicit allowlist.
 */
const imgSrcAllowlist = [
  "'self'",
  "data:",
  "blob:",
  supabaseCspHost,
  cdnCspHosts,
  // WeChat JS-SDK shares QR / image assets via this host.
  "https://res.wx.qq.com",
]
  .filter((part) => part && part.length > 0)
  .join(" ");

/**
 * CSP policy.
 *
 * This is intentionally permissive enough to not break:
 *   - Next.js inline styles and scripts (Next uses nonces in prod but
 *     'unsafe-inline' is needed for Report-Only to avoid false positives
 *     during the evaluation period). TODO: replace with nonces before
 *     switching to enforcing mode in production.
 *   - Supabase REST/Storage (precise project host, not *.supabase.co)
 *   - PDF.js worker (blob: for the worker URL)
 *   - WeChat JS-SDK (https://res.wx.qq.com)
 *   - next/image optimizations (data: for SVG fallbacks)
 *
 * Work Package G changes:
 *   - connect-src uses the precise Supabase project host (or 'self' in
 *     production when env is missing — fail-closed) instead of *.supabase.co.
 *   - img-src is now an explicit allowlist derived from the Supabase host
 *     + MEDIA_CDN_DOMAINS, NOT the previous bare "https:" catch-all.
 *   - object-src 'none' and frame-src 'none' added explicitly.
 *   - upgrade-insecure-requests added.
 *
 * Once production traffic confirms no violations (collected via
 * /api/csp-report), set CSP_ENFORCING=true to switch from Report-Only
 * to enforcing. Before doing so, replace 'unsafe-inline' with per-request
 * nonces (Next.js nonce-based CSP) and remove 'unsafe-eval' if PDF.js
 * / Next.js runtime no longer require it.
 */
const CSP_POLICY = [
  "default-src 'self'",
  // Next.js requires inline styles and scripts during development and
  // for some runtime features. In production with nonces this can be
  // tightened, but for Report-Only we allow it to collect data first.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://res.wx.qq.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  `img-src ${imgSrcAllowlist}`,
  // Supabase REST + Storage (precise project host, not wildcard)
  `connect-src 'self' ${supabaseCspHost} ${cdnCspHosts} https://res.wx.qq.com`.trim(),
  // PDF.js worker uses blob: URLs
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

export async function middleware(request: NextRequest) {
  // Get the response (either the cached/ISR page or a fresh render).
  const response = NextResponse.next();

  // --- Security headers that apply to all responses ---
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()",
  );

  // CSP: Report-Only by default, enforcing when CSP_ENFORCING=true.
  // Operators MUST run a CSP report observation period before flipping
  // the switch — see docs/LAUNCH_CHECKLIST.md.
  if (process.env.CSP_ENFORCING === "true") {
    response.headers.set("Content-Security-Policy", CSP_POLICY);
  } else {
    response.headers.set(
      "Content-Security-Policy-Report-Only",
      CSP_POLICY,
    );
  }

  // HSTS only on HTTPS. On HTTP (localhost/dev), HSTS is ignored by
  // browsers and can cause issues, so we skip it.
  // request.nextUrl.protocol is reliable in Next.js middleware.
  if (request.nextUrl.protocol === "https:") {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }

  // --- Supabase Auth Session Refresh ---
  // Only run on auth-aware paths so public ISR pages remain statically
  // cached. This refreshes the access token cookie when it is near
  // expiry. The helper returns the FINAL NextResponse to return from
  // middleware — either this `response` (no refresh happened) or a NEW
  // response that carries the rotated Set-Cookie headers, the original
  // security headers, and `Cache-Control: private, no-store`.
  // Authorization is NOT done here — getVerifiedAdmin() handles that
  // server-side with a fresh auth.getUser() call.
  if (shouldRefreshSession(request.nextUrl.pathname)) {
    return refreshSupabaseSession(request, response);
  }

  return response;
}

export const config = {
  // Run middleware on all routes EXCEPT static assets.
  // This avoids adding overhead to static file serving.
  // API routes (including /api/health and /api/readiness) DO receive
  // security headers — they only set their own Cache-Control header.
  matcher: [
    // Match all paths except:
    // - /_next/static (static files)
    // - /_next/image (image optimization)
    // - /favicon.ico, robots.txt, sitemap.xml (simple static files)
    // - /assets (public assets if served from /assets)
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|assets).*)",
  ],
};
