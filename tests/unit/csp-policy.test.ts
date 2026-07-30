import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ============================================================
// Phase 3 Task 1: Per-route CSP policy splitting tests
//
// Verifies that:
//   1. isAdminRoute() correctly classifies admin vs public routes.
//   2. Admin routes receive nonce-based Report-Only CSP:
//      - Content-Security-Policy-Report-Only header
//      - script-src uses 'nonce-<nonce>' (no 'unsafe-inline')
//      - style-src uses 'nonce-<nonce>' (no 'unsafe-inline')
//      - No 'unsafe-eval'
//      - No Google Fonts CDN
//      - No WeChat JS-SDK
//   3. Public routes receive STATIC Report-Only CSP:
//      - Content-Security-Policy-Report-Only header
//      - 'unsafe-inline' in script-src and style-src (ISR compat)
//      - WeChat JS-SDK allowed
//      - Google Fonts CDN allowed
//      - No per-request nonce
//   4. Nonce is unique per request (never reused).
//   5. Nonce is a valid UUID format.
//   6. x-nonce request header is forwarded for admin routes.
//   7. x-nonce request header is NOT set for public routes.
//   8. ISR contract: public CSP is identical across requests
//      (no per-request variation).
//   9. CSP_ENFORCING=true switches public CSP to enforcing mode.
//  10. Common directives present in both policies.
//  11. Supabase host is resolved from env and included in CSP.
// ============================================================

const TEST_SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
const TEST_ANON_KEY = "test-anon-key";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", TEST_ANON_KEY);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Dynamic import of the csp-policy module. MUST be called inside an
 * async test body. Calls vi.resetModules() so that env-dependent
 * module-level constants (Supabase host, CDN allowlist) are
 * re-resolved with the current stubbed env values.
 */
async function importCspPolicy() {
  vi.resetModules();
  return await import("@/lib/security/csp-policy");
}

// ============================================================
// 1. Route classification — isAdminRoute
// ============================================================
describe("isAdminRoute — route classification", () => {
  it("classifies /admin and subpaths as admin", async () => {
    const { isAdminRoute } = await importCspPolicy();
    expect(isAdminRoute("/admin")).toBe(true);
    expect(isAdminRoute("/admin/")).toBe(true);
    expect(isAdminRoute("/admin/products")).toBe(true);
    expect(isAdminRoute("/admin/products/123/edit")).toBe(true);
  });

  it("classifies /api/admin and subpaths as admin", async () => {
    const { isAdminRoute } = await importCspPolicy();
    expect(isAdminRoute("/api/admin")).toBe(true);
    expect(isAdminRoute("/api/admin/products")).toBe(true);
  });

  it("does NOT classify /api/internal as admin (JSON API, no HTML)", async () => {
    const { isAdminRoute } = await importCspPolicy();
    expect(isAdminRoute("/api/internal")).toBe(false);
    expect(isAdminRoute("/api/internal/outbox/dispatch")).toBe(false);
  });

  it("does NOT classify public pages as admin", async () => {
    const { isAdminRoute } = await importCspPolicy();
    expect(isAdminRoute("/")).toBe(false);
    expect(isAdminRoute("/products")).toBe(false);
    expect(isAdminRoute("/products/some-slug")).toBe(false);
    expect(isAdminRoute("/documents")).toBe(false);
    expect(isAdminRoute("/contact")).toBe(false);
    expect(isAdminRoute("/about")).toBe(false);
  });

  it("does NOT classify public API routes as admin", async () => {
    const { isAdminRoute } = await importCspPolicy();
    expect(isAdminRoute("/api/readiness")).toBe(false);
    expect(isAdminRoute("/api/health")).toBe(false);
    expect(isAdminRoute("/api/inquiries")).toBe(false);
    expect(isAdminRoute("/api/products/selection")).toBe(false);
    expect(isAdminRoute("/api/analytics/events")).toBe(false);
    expect(isAdminRoute("/api/csp-report")).toBe(false);
  });

  it("does NOT classify admin-prefixed-but-different paths as admin", async () => {
    const { isAdminRoute } = await importCspPolicy();
    expect(isAdminRoute("/admin-foo")).toBe(false);
    expect(isAdminRoute("/administration")).toBe(false);
    expect(isAdminRoute("/api/admin-foo")).toBe(false);
  });
});

// ============================================================
// 2. Admin CSP — nonce-based Report-Only
// ============================================================
describe("Admin CSP — nonce-based Report-Only", () => {
  it("sets Content-Security-Policy-Report-Only on /admin", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/admin");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only");
    expect(csp).toBeTruthy();
    // Phase 9: Admin uses Report-Only (not enforcing).
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("sets Report-Only CSP on /api/admin/products", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/api/admin/products");
    const res = await middleware(req);
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeTruthy();
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("includes 'nonce-' in script-src (no 'unsafe-inline')", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/admin");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only")!;
    expect(csp).toMatch(/script-src[^;]*'nonce-[^']+'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("includes 'nonce-' in style-src (no 'unsafe-inline')", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/admin");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only")!;
    expect(csp).toMatch(/style-src[^;]*'nonce-[^']+'/);
    expect(csp).not.toMatch(/style-src[^;]*'unsafe-inline'/);
  });

  it("does NOT include 'unsafe-eval' in admin CSP", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/admin");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only")!;
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("does NOT include Google Fonts CDN in admin CSP", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/admin");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only")!;
    expect(csp).not.toContain("fonts.googleapis.com");
    expect(csp).not.toContain("fonts.gstatic.com");
  });

  it("does NOT include WeChat JS-SDK in admin script-src", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/admin");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only")!;
    // WeChat JS-SDK must NOT be loadable on admin pages. The SDK
    // is loaded via <script src="https://res.wx.qq.com/...">, so
    // blocking it in script-src is sufficient. img-src and
    // connect-src may still allow WeChat image resources.
    const scriptSrc = csp.match(/script-src[^;]*/)?.[0] ?? "";
    expect(scriptSrc).not.toContain("res.wx.qq.com");
  });

  it("includes Supabase host in connect-src and img-src", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/admin");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only")!;
    expect(csp).toContain("abcdefghijklmnopqrst.supabase.co");
  });

  it("sets Cache-Control: no-store on admin routes (prevent CDN caching nonce mismatch)", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/admin");
    const res = await middleware(req);
    const cc = res.headers.get("Cache-Control")!;
    expect(cc).toContain("no-store");
    expect(cc).toContain("no-cache");
    expect(cc).toContain("must-revalidate");
  });
});

// ============================================================
// 3. Public CSP — static Report-Only
// ============================================================
describe("Public CSP — static Report-Only", () => {
  it("sets Content-Security-Policy-Report-Only on /", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only");
    expect(csp).toBeTruthy();
    // Public must NOT use enforcing CSP (unless CSP_ENFORCING=true).
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("sets Report-Only on /products", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/products");
    const res = await middleware(req);
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeTruthy();
  });

  it("includes 'unsafe-inline' in script-src (ISR compat)", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/products");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only")!;
    expect(csp).toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("includes 'unsafe-inline' in style-src (ISR compat)", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/products");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only")!;
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
  });

  it("includes WeChat JS-SDK (https://res.wx.qq.com)", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only")!;
    expect(csp).toContain("https://res.wx.qq.com");
  });

  it("does NOT include Google Fonts CDN (project uses system fonts)", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only")!;
    expect(csp).not.toContain("fonts.googleapis.com");
    expect(csp).not.toContain("fonts.gstatic.com");
  });

  it("does NOT include a nonce in public CSP", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only")!;
    expect(csp).not.toMatch(/'nonce-/);
  });

  it("includes Supabase host in public CSP", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only")!;
    expect(csp).toContain("abcdefghijklmnopqrst.supabase.co");
  });
});

// ============================================================
// 4. Nonce uniqueness and format
// ============================================================
describe("Nonce — uniqueness and format", () => {
  it("generateNonce returns a valid UUID format", async () => {
    const { generateNonce } = await importCspPolicy();
    const nonce = generateNonce();
    // UUID v4 format: 8-4-4-4-12 hex chars
    expect(nonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("generateNonce produces unique values across calls", async () => {
    const { generateNonce } = await importCspPolicy();
    const nonces = new Set<string>();
    for (let i = 0; i < 100; i++) {
      nonces.add(generateNonce());
    }
    expect(nonces.size).toBe(100);
  });

  it("middleware produces different nonces on consecutive admin requests", async () => {
    const { middleware } = await import("@/middleware");
    const req1 = new NextRequest("https://kzq.test/admin");
    const req2 = new NextRequest("https://kzq.test/admin");
    const res1 = await middleware(req1);
    const res2 = await middleware(req2);
    const csp1 = res1.headers.get("Content-Security-Policy-Report-Only")!;
    const csp2 = res2.headers.get("Content-Security-Policy-Report-Only")!;
    const nonce1 = csp1.match(/'nonce-([^']+)'/)?.[1];
    const nonce2 = csp2.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce1).toBeTruthy();
    expect(nonce2).toBeTruthy();
    expect(nonce1).not.toBe(nonce2);
  });
});

// ============================================================
// 5. x-nonce request header forwarding
// ============================================================
describe("x-nonce request header forwarding", () => {
  it("forwards x-nonce header for admin routes", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/admin");
    const res = await middleware(req);
    // NextResponse.next({ request: { headers } }) communicates the
    // modified request headers to Next.js via the
    // x-middleware-override-headers response header. Each forwarded
    // header appears as x-middleware-request-<name>.
    const overrideHeader = res.headers.get("x-middleware-override-headers");
    expect(overrideHeader).toBeTruthy();
    expect(overrideHeader!.toLowerCase()).toContain("x-nonce");
    const forwardedNonce = res.headers.get("x-middleware-request-x-nonce");
    expect(forwardedNonce).toBeTruthy();
    // The nonce should be a valid UUID
    expect(forwardedNonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("does NOT set x-nonce header for public routes", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/products");
    const res = await middleware(req);
    // Public routes do not create a modified request — the
    // x-middleware-override-headers header should not list x-nonce.
    const overrideHeader = res.headers.get("x-middleware-override-headers");
    if (overrideHeader) {
      expect(overrideHeader.toLowerCase()).not.toContain("x-nonce");
    }
    expect(res.headers.get("x-middleware-request-x-nonce")).toBeNull();
  });

  it("forwards x-nonce for /api/admin subpaths", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/api/admin/products");
    const res = await middleware(req);
    const overrideHeader = res.headers.get("x-middleware-override-headers");
    expect(overrideHeader).toBeTruthy();
    expect(overrideHeader!.toLowerCase()).toContain("x-nonce");
    expect(res.headers.get("x-middleware-request-x-nonce")).toBeTruthy();
  });
});

// ============================================================
// 6. ISR contract — public CSP is static
// ============================================================
describe("ISR contract — public CSP is static", () => {
  it("produces identical CSP for the same public route across requests", async () => {
    const { middleware } = await import("@/middleware");
    const req1 = new NextRequest("https://kzq.test/products");
    const req2 = new NextRequest("https://kzq.test/products");
    const res1 = await middleware(req1);
    const res2 = await middleware(req2);
    const csp1 = res1.headers.get("Content-Security-Policy-Report-Only");
    const csp2 = res2.headers.get("Content-Security-Policy-Report-Only");
    // ISR requires that the CSP is deterministic — no per-request
    // nonce or random value.
    expect(csp1).toBe(csp2);
  });

  it("produces identical CSP across different public routes (module-level resolution)", async () => {
    const { middleware } = await import("@/middleware");
    const req1 = new NextRequest("https://kzq.test/");
    const req2 = new NextRequest("https://kzq.test/products");
    const res1 = await middleware(req1);
    const res2 = await middleware(req2);
    const csp1 = res1.headers.get("Content-Security-Policy-Report-Only");
    const csp2 = res2.headers.get("Content-Security-Policy-Report-Only");
    // Both public routes share the same static CSP (resolved at
    // module load from env). This is what allows ISR pages to be
    // statically cached with a consistent CSP header.
    expect(csp1).toBe(csp2);
  });

  it("does NOT set Cache-Control: private, no-store on public routes", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/products");
    const res = await middleware(req);
    // ISR pages must be cacheable — the middleware must NOT add
    // anti-cache headers to public routes.
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});

// ============================================================
// 7. CSP_ENFORCING flag — public route mode switch
// ============================================================
describe("CSP_ENFORCING flag — public route mode switch", () => {
  it("defaults to Report-Only on public routes when CSP_ENFORCING is unset", async () => {
    vi.stubEnv("CSP_ENFORCING", "");
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/products");
    const res = await middleware(req);
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeTruthy();
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("switches to enforcing CSP on public routes when CSP_ENFORCING=true", async () => {
    vi.stubEnv("CSP_ENFORCING", "true");
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/products");
    const res = await middleware(req);
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
  });

  it("does NOT affect admin routes (admin is always Report-Only)", async () => {
    vi.stubEnv("CSP_ENFORCING", "true");
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/admin");
    const res = await middleware(req);
    // Phase 9: Admin is always Report-Only, CSP_ENFORCING only affects public.
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeTruthy();
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("does NOT affect admin routes when CSP_ENFORCING is unset", async () => {
    vi.stubEnv("CSP_ENFORCING", "");
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/admin");
    const res = await middleware(req);
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeTruthy();
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });
});

// ============================================================
// 8. Common directives — present in both policies
// ============================================================
describe("Common directives — present in both admin and public policies", () => {
  it("includes frame-ancestors 'none' in admin CSP", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/admin");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only")!;
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("includes frame-ancestors 'none' in public CSP", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only")!;
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("includes object-src 'none' in both policies", async () => {
    const { middleware } = await import("@/middleware");
    const adminRes = await middleware(new NextRequest("https://kzq.test/admin"));
    const publicRes = await middleware(new NextRequest("https://kzq.test/"));
    expect(adminRes.headers.get("Content-Security-Policy-Report-Only")!).toContain(
      "object-src 'none'",
    );
    expect(
      publicRes.headers.get("Content-Security-Policy-Report-Only")!,
    ).toContain("object-src 'none'");
  });

  it("includes base-uri 'self' in both policies", async () => {
    const { middleware } = await import("@/middleware");
    const adminRes = await middleware(new NextRequest("https://kzq.test/admin"));
    const publicRes = await middleware(new NextRequest("https://kzq.test/"));
    expect(adminRes.headers.get("Content-Security-Policy-Report-Only")!).toContain(
      "base-uri 'self'",
    );
    expect(
      publicRes.headers.get("Content-Security-Policy-Report-Only")!,
    ).toContain("base-uri 'self'");
  });

  it("includes form-action 'self' in both policies", async () => {
    const { middleware } = await import("@/middleware");
    const adminRes = await middleware(new NextRequest("https://kzq.test/admin"));
    const publicRes = await middleware(new NextRequest("https://kzq.test/"));
    expect(adminRes.headers.get("Content-Security-Policy-Report-Only")!).toContain(
      "form-action 'self'",
    );
    expect(
      publicRes.headers.get("Content-Security-Policy-Report-Only")!,
    ).toContain("form-action 'self'");
  });

  it("includes upgrade-insecure-requests in both policies", async () => {
    const { middleware } = await import("@/middleware");
    const adminRes = await middleware(new NextRequest("https://kzq.test/admin"));
    const publicRes = await middleware(new NextRequest("https://kzq.test/"));
    expect(adminRes.headers.get("Content-Security-Policy-Report-Only")!).toContain(
      "upgrade-insecure-requests",
    );
    expect(
      publicRes.headers.get("Content-Security-Policy-Report-Only")!,
    ).toContain("upgrade-insecure-requests");
  });

  it("includes report-to and report-uri in both policies", async () => {
    const { middleware } = await import("@/middleware");
    const adminRes = await middleware(new NextRequest("https://kzq.test/admin"));
    const publicRes = await middleware(new NextRequest("https://kzq.test/"));
    const adminCsp = adminRes.headers.get("Content-Security-Policy-Report-Only")!;
    const publicCsp = publicRes.headers.get(
      "Content-Security-Policy-Report-Only",
    )!;
    expect(adminCsp).toContain("report-to csp-endpoint");
    expect(adminCsp).toContain("report-uri /api/csp-report");
    expect(publicCsp).toContain("report-to csp-endpoint");
    expect(publicCsp).toContain("report-uri /api/csp-report");
  });
});

// ============================================================
// 9. Supabase host resolution
// ============================================================
describe("Supabase host resolution", () => {
  it("includes the canonical Supabase host when URL is set", async () => {
    // Must be exactly 20 lowercase alphanumeric chars to match the
    // canonical Supabase project ref pattern.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://zyxwvutsrqponmlkjiha.supabase.co");
    const { buildAdminCspPolicy, buildPublicCspPolicy } = await importCspPolicy();
    const nonce = "test-nonce";
    const adminCsp = buildAdminCspPolicy(nonce);
    const publicCsp = buildPublicCspPolicy();
    expect(adminCsp).toContain("zyxwvutsrqponmlkjiha.supabase.co");
    expect(publicCsp).toContain("zyxwvutsrqponmlkjiha.supabase.co");
  });

  it("falls back to 'self' in production when Supabase URL is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    const { buildPublicCspPolicy } = await importCspPolicy();
    const csp = buildPublicCspPolicy();
    // The fallback is 'self' — no external Supabase host.
    expect(csp).not.toMatch(/[a-z0-9]{20}\.supabase\.co/);
  });

  it("falls back to *.supabase.co in non-production when URL is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    const { buildPublicCspPolicy } = await importCspPolicy();
    const csp = buildPublicCspPolicy();
    expect(csp).toContain("*.supabase.co");
  });
});

// ============================================================
// 10. CSP_REPORT_PATH constant
// ============================================================
describe("CSP_REPORT_PATH constant", () => {
  it("is /api/csp-report", async () => {
    const { CSP_REPORT_PATH } = await importCspPolicy();
    expect(CSP_REPORT_PATH).toBe("/api/csp-report");
  });
});
