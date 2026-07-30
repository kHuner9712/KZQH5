// ============================================================
// CSP Policy Builder (Phase 3 Task 1)
//
// Builds per-route Content Security Policy strings.
//
// Route categories:
//   1. Admin routes (/admin/**, /api/admin/**) — nonce-based CSP,
//      Report-Only mode (Phase 9: switched from enforcing to fix
//      black screen issues on EdgeOne deployments).
//   2. Public routes (everything else) — static CSP, Report-Only,
//      retains 'unsafe-inline' for ISR compatibility, with
//      report-to/report-uri wired.
//
// Why split:
//   - Admin pages are dynamically rendered (force-dynamic) and
//     can safely use per-request nonces without breaking ISR.
//   - Public pages use ISR — per-request nonces would force every
//     page to be dynamically rendered, destroying the ISR cache.
//   - Admin routes use nonce-based CSP (no 'unsafe-inline') to
//     establish a stricter policy baseline. Report-Only mode
//     allows us to collect violations without breaking pages.
//
// Nonce generation:
//   - Uses Web Crypto API (crypto.randomUUID()) which is available
//     in the Edge Runtime.
//   - Nonce is 32+ characters of base64url, passed via the
//     `x-nonce` request header so Next.js can inject it into
//     <Script nonce={nonce}> tags.
// ============================================================

const SUPABASE_PROJECT_HOST_PATTERN = /^[a-z0-9]{20}\.supabase\.co$/;

/**
 * Resolve the precise Supabase project host from env at module load.
 * Falls back to "*.supabase.co" ONLY in non-production dev mode.
 * In production, falls back to 'self' (fail-closed).
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
    return "'self'";
  }
  return "https://*.supabase.co";
}

/**
 * Resolve the MEDIA_CDN_DOMAINS allowlist for img-src / connect-src.
 */
function resolveCdnCspHosts(): string {
  const cdnRaw = (process.env.MEDIA_CDN_DOMAINS || "").trim();
  if (!cdnRaw) return "";
  const hosts: string[] = [];
  for (const raw of cdnRaw.split(",")) {
    const trimmed = raw.trim().toLowerCase();
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

const imgSrcAllowlist = [
  "'self'",
  "data:",
  "blob:",
  supabaseCspHost,
  cdnCspHosts,
  "https://res.wx.qq.com",
]
  .filter((part) => part && part.length > 0)
  .join(" ");

const connectSrcAllowlist = [
  "'self'",
  supabaseCspHost,
  cdnCspHosts,
  "https://res.wx.qq.com",
]
  .filter((part) => part && part.length > 0)
  .join(" ");

/**
 * Common CSP directives shared by both admin and public policies.
 * These do not change per-route.
 */
const COMMON_DIRECTIVES = [
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
  // Both policies wire CSP reporting so violations are collected
  // regardless of route. report-to (modern) + report-uri (legacy).
  "report-to csp-endpoint",
  "report-uri /api/csp-report",
];

/**
 * Build the CSP policy for ADMIN routes (/admin/**, /api/admin/**).
 *
 * This is a nonce-based, enforcing CSP:
 *   - script-src uses 'nonce-<nonce>' instead of 'unsafe-inline'
 *   - style-src uses 'nonce-<nonce>' instead of 'unsafe-inline'
 *   - No 'unsafe-eval' (admin pages do not need PDF.js)
 *   - No Google Fonts CDN (admin uses system fonts)
 *   - No WeChat JS-SDK (admin does not need social sharing)
 *   - Supabase host is still allowed (auth + data)
 *
 * The nonce must be generated per-request using generateNonce().
 */
export function buildAdminCspPolicy(nonce: string): string {
  const directives = [
    "default-src 'self'",
    // nonce-based script-src — no 'unsafe-inline', no 'unsafe-eval'
    `script-src 'self' 'nonce-${nonce}'`,
    // nonce-based style-src — no 'unsafe-inline'
    `style-src 'self' 'nonce-${nonce}'`,
    "font-src 'self' data:",
    `img-src ${imgSrcAllowlist}`,
    `connect-src ${connectSrcAllowlist}`,
    ...COMMON_DIRECTIVES,
  ];
  return directives.join("; ");
}

/**
 * Build the CSP policy for PUBLIC routes (everything except /admin/**).
 *
 * This is a static, Report-Only CSP:
 *   - Retains 'unsafe-inline' for script-src and style-src (ISR compat)
 *   - Retains 'unsafe-eval' (PDF.js / Next.js runtime may need it)
 *   - Allows WeChat JS-SDK (https://res.wx.qq.com)
 *   - No Google Fonts CDN (project uses system fonts only)
 *   - Supabase host is allowed
 *
 * This policy is intentionally permissive to avoid breaking ISR pages.
 * It will be tightened in a future phase after migrating to next/font
 * and removing the WeChat SDK dependency from public pages.
 */
export function buildPublicCspPolicy(): string {
  const directives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://res.wx.qq.com",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `img-src ${imgSrcAllowlist}`,
    `connect-src ${connectSrcAllowlist}`,
    ...COMMON_DIRECTIVES,
  ];
  return directives.join("; ");
}

/**
 * Check if a pathname is an admin route that should receive the
 * nonce-based enforcing CSP.
 *
 * Admin routes:
 *   - /admin/** (admin pages)
 *   - /api/admin/** (admin API routes)
 *
 * Note: /api/internal/** is NOT an admin route for CSP purposes —
 * internal API routes return JSON and do not render HTML, so CSP
 * has no effect on them. They still receive the public CSP for
 * header consistency.
 */
export function isAdminRoute(pathname: string): boolean {
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return true;
  if (pathname === "/api/admin" || pathname.startsWith("/api/admin/")) return true;
  return false;
}

/**
 * Generate a cryptographically random nonce for CSP.
 *
 * Uses Web Crypto API (crypto.randomUUID()) which is available in
 * the Edge Runtime. The nonce is a 36-character UUID string, which
 * is safe to use in CSP 'nonce-' directives without base64 encoding.
 *
 * The nonce is:
 *   - Generated per-request (never reused)
 *   - Passed to Next.js via the `x-nonce` request header
 *   - Injected into <Script nonce={nonce}> tags by Next.js
 *   - Included in the CSP script-src and style-src directives
 */
export function generateNonce(): string {
  return crypto.randomUUID();
}

/**
 * CSP report endpoint path (used for Reporting-Endpoints header).
 */
export const CSP_REPORT_PATH = "/api/csp-report";
