// ============================================================
// KZQ Security + Auth Session Middleware
//
// Phase 3: Per-route CSP policy splitting.
//   - Admin routes (/admin/**, /api/admin/**): nonce-based enforcing
//     CSP, no 'unsafe-inline', no 'unsafe-eval'.
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
//   - Content-Security-Policy (admin, enforcing) OR
//     Content-Security-Policy-Report-Only (public, Report-Only)
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
//   - Public CSP is static (no per-request nonce) to preserve ISR.
//   - Admin CSP uses per-request nonce (admin pages are force-dynamic).
// ============================================================

import { NextResponse, type NextRequest } from "next/server";
import {
  refreshSupabaseSession,
  shouldRefreshSession,
} from "@/lib/supabase/middleware-session";
import {
  buildAdminCspPolicy,
  buildPublicCspPolicy,
  generateNonce,
  isAdminRoute,
  CSP_REPORT_PATH,
} from "@/lib/security/csp-policy";

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isAdmin = isAdminRoute(pathname);

  // --- Build response ---
  // For admin routes, we need to forward the nonce to Next.js via
  // request headers so that <Script nonce={...}> tags can use it.
  // This requires creating the response with modified request headers.
  let response: NextResponse;

  if (isAdmin) {
    // Generate a per-request nonce for admin routes.
    const nonce = generateNonce();

    // Forward the nonce to Next.js via request headers. Next.js reads
    // the `x-nonce` header and makes it available to pages via
    // headers() — allowing <Script nonce={nonce}> to work.
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);

    response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });

    // Admin CSP: nonce-based, Report-Only.
    // Phase 9: Switched from enforcing to Report-Only because enforcing
    // mode caused black screen issues on certain deployments (EdgeOne)
    // when Next.js runtime or third-party libraries triggered CSP
    // violations that blocked JS execution. Report-Only still collects
    // violations via /api/csp-report, but does NOT block execution —
    // the page remains functional while we identify and fix violations.
    const adminCsp = buildAdminCspPolicy(nonce);
    response.headers.set("Content-Security-Policy-Report-Only", adminCsp);

    // Admin pages use per-request nonces in CSP. The HTML body contains
    // inline scripts tagged with that nonce. If a CDN (EdgeOne) caches
    // the HTML, a subsequent request gets a DIFFERENT nonce in the CSP
    // header but the OLD nonce in the cached HTML scripts — CSP blocks
    // all inline scripts and the page cannot hydrate (black screen).
    // Prevent caching entirely on admin routes.
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
  // URL. Both admin (enforcing) and public (Report-Only) policies
  // include report-to and report-uri directives.
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
