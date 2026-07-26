// ============================================================
// KZQ Security Response Headers Middleware
//
// Phase 10: Adds security headers to all responses.
//
// Headers applied:
//   - X-Content-Type-Options: nosniff
//   - Referrer-Policy: strict-origin-when-cross-origin
//   - Permissions-Policy: restrictive (no camera, mic, geo, payment)
//   - X-Frame-Options: DENY (clickjacking protection)
//   - Strict-Transport-Security: max-age=31536000; includeSubDomains
//     (only on HTTPS — HSTS over HTTP is ignored by browsers and can
//     cause issues during local development)
//   - Content-Security-Policy-Report-Only: restrictive policy that allows
//     Supabase, Next.js internals, PDF.js worker, and WeChat JS-SDK.
//     Report-Only means violations are logged to the console but NOT
//     blocked — this is intentional to avoid breaking ISR, PDF viewer,
//     or WeChat integration before we have production confirmation.
//
// ISR safety:
//   - This middleware does NOT read request.cookies, request.headers
//     (except the protocol via request.nextUrl which is needed for HSTS),
//     or any other request property that would force dynamic rendering.
//   - It only adds response headers via NextResponse.next().
//   - Statically generated and ISR pages continue to be served from cache.
//   - The middleware matcher excludes static assets (_next/static, images,
//     favicon) so they are served without overhead.
// ============================================================

import { NextResponse, type NextRequest } from "next/server";

/**
 * CSP Report-Only policy.
 *
 * This is intentionally permissive enough to not break:
 *   - Next.js inline styles and scripts (Next uses nonces in prod but
 *     'unsafe-inline' is needed for Report-Only to avoid false positives
 *     during the evaluation period)
 *   - Supabase REST/Storage (https://*.supabase.co)
 *   - PDF.js worker (blob: for the worker URL)
 *   - WeChat JS-SDK (https://res.wx.qq.com)
 *   - next/image optimizations (data: for SVG fallbacks)
 *
 * Once production traffic confirms no violations, this should be moved
 * to an enforcing CSP and 'unsafe-inline' should be replaced with nonces.
 */
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  // Next.js requires inline styles and scripts during development and
  // for some runtime features. In production with nonces this can be
  // tightened, but for Report-Only we allow it to collect data first.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://res.wx.qq.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  // Supabase REST + Storage
  "connect-src 'self' https://*.supabase.co https://res.wx.qq.com",
  // PDF.js worker uses blob: URLs
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
].join("; ");

export function middleware(request: NextRequest) {
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

  // CSP as Report-Only so we can collect violations without blocking.
  response.headers.set("Content-Security-Policy-Report-Only", CSP_REPORT_ONLY);

  // HSTS only on HTTPS. On HTTP (localhost/dev), HSTS is ignored by
  // browsers and can cause issues, so we skip it.
  // request.nextUrl.protocol is reliable in Next.js middleware.
  if (request.nextUrl.protocol === "https:") {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
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
