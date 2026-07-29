import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ============================================================
// Phase 1 Task 3: CSP Reporting Header Tests
//
// Verifies that the middleware:
//   1. Includes `report-to csp-endpoint` in the CSP policy (modern
//      Reporting API).
//   2. Includes `report-uri /api/csp-report` in the CSP policy
//      (legacy fallback for Safari / older browsers).
//   3. Sets the `Reporting-Endpoints` response header mapping
//      "csp-endpoint" to an absolute URL.
//   4. The Reporting-Endpoints URL contains no sensitive tokens.
//   5. Both Report-Only and enforcing modes include reporting.
//   6. Reporting headers are present on all routes (public + admin).
// ============================================================

const TEST_SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
const TEST_ANON_KEY = "test-anon-key";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", TEST_ANON_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Phase 1 Task 3: CSP reporting directives in CSP header", () => {
  it("includes report-to csp-endpoint in Report-Only mode", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/products");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only");
    expect(csp).toBeTruthy();
    expect(csp).toContain("report-to csp-endpoint");
  });

  it("includes report-uri /api/csp-report in Report-Only mode", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/products");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy-Report-Only");
    expect(csp).toBeTruthy();
    expect(csp).toContain("report-uri /api/csp-report");
  });

  it("includes report-to and report-uri in enforcing mode", async () => {
    vi.stubEnv("CSP_ENFORCING", "true");
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/products");
    const res = await middleware(req);
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain("report-to csp-endpoint");
    expect(csp).toContain("report-uri /api/csp-report");
    // Should NOT also set Report-Only when enforcing is active.
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
  });
});

describe("Phase 1 Task 3: Reporting-Endpoints response header", () => {
  it("sets Reporting-Endpoints header with csp-endpoint", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/products");
    const res = await middleware(req);
    const header = res.headers.get("Reporting-Endpoints");
    expect(header).toBeTruthy();
    expect(header).toContain("csp-endpoint");
  });

  it("uses an absolute URL for the reporting endpoint", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/products");
    const res = await middleware(req);
    const header = res.headers.get("Reporting-Endpoints");
    expect(header).toBeTruthy();
    // The URL must be absolute (start with https://).
    expect(header).toMatch(/csp-endpoint="https:\/\/kzq\.test\/api\/csp-report"/);
  });

  it("preserves the request origin in the endpoint URL", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://staging.kzq.example.com/admin");
    const res = await middleware(req);
    const header = res.headers.get("Reporting-Endpoints");
    expect(header).toContain(
      'csp-endpoint="https://staging.kzq.example.com/api/csp-report"',
    );
  });

  it("does NOT embed tokens or secrets in the endpoint URL", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/products");
    const res = await middleware(req);
    const header = res.headers.get("Reporting-Endpoints");
    expect(header).not.toMatch(/[?&](token|key|secret|apikey)=/i);
    // The URL must be exactly /api/csp-report with no query string.
    expect(header).toMatch(/\/api\/csp-report"/);
    expect(header).not.toMatch(/\/api\/csp-report\?/);
  });
});

describe("Phase 1 Task 3: reporting headers on all routes", () => {
  it("sets reporting headers on public routes", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/products");
    const res = await middleware(req);
    expect(res.headers.get("Reporting-Endpoints")).toBeTruthy();
    const csp = res.headers.get("Content-Security-Policy-Report-Only");
    expect(csp).toContain("report-to csp-endpoint");
    expect(csp).toContain("report-uri /api/csp-report");
  });

  it("sets reporting headers on admin routes (enforcing CSP, Phase 3)", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/admin");
    const res = await middleware(req);
    expect(res.headers.get("Reporting-Endpoints")).toBeTruthy();
    // Phase 3: admin routes use enforcing Content-Security-Policy
    // (not Report-Only). The reporting directives are inside the
    // enforcing CSP header.
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain("report-to csp-endpoint");
    expect(csp).toContain("report-uri /api/csp-report");
  });

  it("sets reporting headers on API routes", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest("https://kzq.test/api/readiness");
    const res = await middleware(req);
    expect(res.headers.get("Reporting-Endpoints")).toBeTruthy();
  });
});
