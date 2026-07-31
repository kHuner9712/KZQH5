// ============================================================
// CSP Policy Builder
//
// Builds per-route Content Security Policy strings.
//
// Route categories:
//   1. Admin routes (/admin/**, /api/admin/**) — static CSP using
//      'unsafe-inline' for script-src/style-src. Phase 9 attempted
//      nonce-based CSP but Next.js 15 App Router does NOT inject the
//      nonce into its internal inline scripts (RSC payload, hydration
//      data), so the browser blocked them and the page could not
//      hydrate (black screen). 'unsafe-inline' is the only reliable
//      way to allow Next.js internal scripts. Other directives
//      (img-src, connect-src, frame-ancestors, object-src) remain
//      strict to provide meaningful protection.
//   2. Public routes (everything else) — static CSP, Report-Only,
//      retains 'unsafe-inline' for ISR compatibility, with
//      report-to/report-uri wired.
//
// Both admin and public policies are served as Report-Only so that
// violations are collected via /api/csp-report without blocking
// page execution.
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
 * Uses 'unsafe-inline' for script-src and style-src. This is required
 * because Next.js 15 App Router generates internal inline scripts
 * (RSC payload, hydration data) that do NOT accept a nonce attribute.
 * A nonce-based CSP blocks these scripts and the page cannot hydrate.
 *
 * Other directives remain strict:
 *   - No 'unsafe-eval' (admin pages do not need PDF.js)
 *   - No Google Fonts CDN (admin uses system fonts)
 *   - No WeChat JS-SDK (admin does not need social sharing)
 *   - Supabase host is still allowed (auth + data)
 *   - frame-ancestors 'none', object-src 'none', etc.
 *
 * The policy is served as Report-Only so violations are collected
 * without blocking page execution.
 */
export function buildAdminCspPolicy(): string {
  const directives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
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
 * This is a static CSP (no per-request nonce). The actual header
 * (Report-Only vs Enforcing) is chosen by `middleware.ts` based on
 * `CSP_ENFORCING`:
 *   - `CSP_ENFORCING=true`  → middleware sets `Content-Security-Policy`
 *   - unset / "false"      → middleware sets `Content-Security-Policy-Report-Only`
 *
 * Directive choices:
 *   - Retains 'unsafe-inline' for script-src and style-src (ISR compat —
 *     Next.js 15 App Router generates internal inline scripts that do not
 *     accept a nonce)
 *   - Does NOT include 'unsafe-eval' (KZQ-P1-003, removed 2026-07-31).
 *     Audit confirmed no real dependency: project source has zero
 *     eval/new Function calls; pdfjs-dist worker has `new Function` for
 *     PostScript calculator JIT but `isEvalSupported()` probe is
 *     try/catch-wrapped and `PostScriptEvaluator` interpreter fallback
 *     exists (pdf.worker.mjs:30173-30182) — CSP blocking eval auto-
 *     falls-back with no function loss, only minor perf degrade for
 *     PostScript calculator PDFs (rare in product catalogs); WeChat
 *     JS-SDK loaded via external `<script src>`, whitelisted by host
 *     `https://res.wx.qq.com`, does NOT need unsafe-eval; Next.js 15
 *     production runtime does not need unsafe-eval (dev-only React
 *     Refresh does).
 *   - Allows WeChat JS-SDK (https://res.wx.qq.com)
 *   - No Google Fonts CDN (project uses system fonts only)
 *   - Supabase host is allowed
 *
 * Other directives (img-src allowlist, connect-src allowlist,
 * frame-ancestors 'none', object-src 'none', etc.) ARE enforced when
 * middleware emits the enforcing header.
 *
 * This policy is intentionally permissive to avoid breaking ISR pages.
 * It will be tightened in a future phase after migrating to next/font
 * and removing the WeChat SDK dependency from public pages.
 */
export function buildPublicCspPolicy(): string {
  const directives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://res.wx.qq.com",
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
 * admin CSP (stricter than public — no WeChat SDK, no Google Fonts,
 * no 'unsafe-eval').
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
 * CSP report endpoint path (used for Reporting-Endpoints header).
 */
export const CSP_REPORT_PATH = "/api/csp-report";
