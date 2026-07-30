// ============================================================
// KZQ Security + Auth Session Middleware
//
// Per-route CSP policy splitting.
//   - Admin routes (/admin/**, /api/admin/**): static Report-Only CSP
//     with 'unsafe-inline' (Next.js internal inline scripts need it).
//     No WeChat SDK, no Google Fonts, no 'unsafe-eval'.
//   - Public routes: static Report-Only CSP, retains 'unsafe-inline'
//     for ISR compatibility.
//
// Headers applied:
//   - X-Content-Type-Options: nosniff
//   - Referrer-Policy: strict-origin-when-cross-origin
//   - Permissions-Policy: restrictive (no camera, mic, geo, payment)
//   - X-Frame-Options: DENY (clickjacking protection)
//   - Strict-Transport-Security: max-age=31536000; includeSubDomains
//     (only on HTTPS)
//   - Content-Security-Policy-Report-Only (admin + public, Report-Only)
//   - Reporting-Endpoints: csp-endpoint="<absolute-url>"
//
// Session refresh:
//   - On /admin/**, /api/admin/**, /api/internal/** paths, the middleware
//     refreshes Supabase Auth sessions via the Edge Runtime compatible
//     refresh logic (lib/supabase/middleware-session.ts).
//   - Failures during refresh do NOT block the request.
//
// ISR safety:
//   - Session refresh is ONLY triggered on auth-aware paths. Public ISR
//     pages never have their auth cookies read, so they remain statically
//     cached.
//   - Both admin and public CSP are static (no per-request nonce) to
//     preserve ISR and avoid blocking Next.js internal inline scripts.
// ============================================================

import { NextResponse, type NextRequest } from "next/server";
import {
  refreshSupabaseSession,
  shouldRefreshSession,
} from "@/lib/supabase/middleware-session";
import {
  buildAdminCspPolicy,
  buildPublicCspPolicy,
  isAdminRoute,
  CSP_REPORT_PATH,
} from "@/lib/security/csp-policy";

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isAdmin = isAdminRoute(pathname);

  // --- Build response ---
  let response: NextResponse;

  if (isAdmin) {
    response = NextResponse.next();

    // Admin CSP: static, Report-Only. Uses 'unsafe-inline' for
    // script-src/style-src because Next.js 15 App Router generates
    // internal inline scripts (RSC payload, hydration data) that
    // do NOT accept a nonce attribute — a nonce-based CSP blocks
    // them and the page cannot hydrate (black screen). Other
    // directives (img-src, connect-src, frame-ancestors, object-src)
    // remain strict. Report-Only collects violations without blocking.
    const adminCsp = buildAdminCspPolicy();
    response.headers.set("Content-Security-Policy-Report-Only", adminCsp);

    // Admin pages are force-dynamic and auth-aware. Prevent CDN
    // caching so stale HTML/headers are never served.
    response.headers.set(
      "Cache-Control",
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
    response.headers.set("Expires", "0");
    response.headers.set("Pragma", "no-cache");
  } else {
    response = NextResponse.next();

    // Public CSP: static, Report-Only by default.
    // Retains 'unsafe-inline' for ISR compatibility.
    const publicCsp = buildPublicCspPolicy();
    if (process.env.CSP_ENFORCING === "true") {
      // Allow operators to enforce on public routes too, but this
      // is not recommended until 'unsafe-inline' is removed.
      response.headers.set("Content-Security-Policy", publicCsp);
    } else {
      response.headers.set(
        "Content-Security-Policy-Report-Only",
        publicCsp,
      );
    }
  }

  // --- Security headers that apply to all responses ---
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()",
  );

  // --- CSP Reporting (both admin and public) ---
  // The Reporting-Endpoints header maps "csp-endpoint" to an absolute
  // URL. Both admin and public Report-Only policies include report-to
  // and report-uri directives.
  const cspReportEndpoint = new URL(CSP_REPORT_PATH, request.url).toString();
  response.headers.set(
    "Reporting-Endpoints",
    `csp-endpoint="${cspReportEndpoint}"`,
  );

  // --- HSTS (HTTPS only) ---
  if (request.nextUrl.protocol === "https:") {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }

  // --- Supabase Auth Session Refresh ---
  // Only run on auth-aware paths so public ISR pages remain statically
  // cached. The helper returns the FINAL NextResponse to return from
  // middleware — either this `response` (no refresh happened) or a NEW
  // response that carries the rotated Set-Cookie headers, the original
  // security headers, and `Cache-Control: private, no-store`.
  if (shouldRefreshSession(pathname)) {
    return refreshSupabaseSession(request, response);
  }

  return response;
}

export const config = {
  // Run middleware on all routes EXCEPT static assets.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|assets).*)",
  ],
};
