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
//     (only when the USER-FACING protocol is HTTPS — see KZQ-P1-013)
//   - Content-Security-Policy-Report-Only (admin + public, Report-Only)
//   - Reporting-Endpoints: csp-endpoint="<absolute-url>"
//     (uses canonical origin when configured — see KZQ-P1-013)
//
// KZQ-P1-013 — TLS termination & external protocol:
//   EdgeOne terminates TLS and forwards HTTP internally, so
//   request.nextUrl.protocol reflects the INTERNAL origin protocol
//   (often "http:"), NOT what the user's browser sees. Two fixes:
//     1. HSTS is now set based on x-forwarded-proto (trusted EdgeOne
//        proxy header) instead of request.nextUrl.protocol.
//     2. Reporting-Endpoints URL is built from the canonical origin
//        (CANONICAL_APP_ORIGIN) when configured, so it is always
//        https:// and never mixed-content. Dev fallback uses the
//        user-facing protocol + forwarded host.
//   HSTS should ALSO be configured at the EdgeOne edge layer for
//   requests that never reach the origin — see docs/EDGEONE_WAF_RULES.md §9.
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
import { getCanonicalOriginConfig } from "@/lib/config/canonical-origin";

/**
 * Resolve the user-facing protocol from the trusted EdgeOne proxy header.
 *
 * EdgeOne terminates TLS and forwards HTTP internally, so
 * `request.nextUrl.protocol` reflects the INTERNAL origin protocol
 * (often "http:"), NOT what the user's browser sees. The
 * `x-forwarded-proto` header is set by EdgeOne at the proxy boundary
 * and reflects the user-facing protocol. Falls back to
 * `request.nextUrl.protocol` when the header is absent (direct access,
 * local dev without a proxy).
 *
 * KZQ-P1-013: must not rely on the internal HTTP forwarding protocol
 * to determine user-side HTTPS.
 *
 * Security note: if an attacker injects `x-forwarded-proto: https` on
 * a direct HTTP request (no proxy), HSTS would be set on an HTTP
 * response — but browsers IGNORE HSTS on HTTP responses, so this is
 * not exploitable. Behind EdgeOne, the header is overwritten at the
 * proxy boundary.
 */
function getUserFacingProtocol(request: NextRequest): "https" | "http" {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) {
    // x-forwarded-proto may be a comma-separated list when multiple
    // proxies are chained; the FIRST value is the original client proto.
    const first = forwarded.split(",")[0].trim().toLowerCase();
    if (first === "https" || first === "http") return first;
  }
  return request.nextUrl.protocol === "https:" ? "https" : "http";
}

/**
 * Build the absolute CSP reporting endpoint URL.
 *
 * When CANONICAL_APP_ORIGIN is configured (production), uses the
 * canonical origin so the URL is always `https://` — preventing
 * mixed-content blocking of CSP violation reports on HTTPS pages.
 *
 * When canonical origin is NOT configured (dev/local), falls back to
 * the user-facing protocol + forwarded host, which is correct for
 * localhost.
 *
 * KZQ-P1-013: must not generate `http://` URLs on HTTPS pages.
 */
function buildCspReportEndpointUrl(request: NextRequest): string {
  const canonical = getCanonicalOriginConfig();
  if (canonical.origins.length > 0) {
    return canonical.origins[0].display + CSP_REPORT_PATH;
  }
  // Dev fallback: use user-facing protocol + forwarded host.
  const proto = getUserFacingProtocol(request);
  const host =
    request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (host) {
    return `${proto}://${host}${CSP_REPORT_PATH}`;
  }
  // Last resort: derive from request.url (may be internal http).
  return new URL(CSP_REPORT_PATH, request.url).toString();
}

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
  //
  // KZQ-P1-013: use canonical origin when configured (always https,
  // never mixed-content). Dev fallback uses the user-facing protocol
  // + forwarded host.
  const cspReportEndpoint = buildCspReportEndpointUrl(request);
  response.headers.set(
    "Reporting-Endpoints",
    `csp-endpoint="${cspReportEndpoint}"`,
  );

  // --- HSTS (user-facing HTTPS only) ---
  // KZQ-P1-013: EdgeOne terminates TLS and may forward HTTP internally,
  // so we check x-forwarded-proto (trusted EdgeOne proxy header) rather
  // than request.nextUrl.protocol (which reflects the internal origin
  // protocol). HSTS should ALSO be configured at the EdgeOne edge layer
  // for requests that never reach the origin — see
  // docs/EDGEONE_WAF_RULES.md §9.
  if (getUserFacingProtocol(request) === "https") {
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
