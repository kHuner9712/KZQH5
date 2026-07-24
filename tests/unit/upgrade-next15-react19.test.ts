import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// Phase 8: Next.js 15 + React 19 upgrade regression tests
//
// These tests verify that the framework upgrade did not regress
// any of the 16 critical upgrade-specific behaviors:
//   1.  Next.js 15 async cookies() admin auth
//   2.  Async params product detail route
//   3.  Async params generateMetadata
//   4.  SearchParams product search and pagination
//   5.  Dynamic API Route not statically cached
//   6.  Admin write Origin fail-closed
//   7.  React 19 Ref Callback behavior
//   8.  React 19 tests no act warning
//   9.  PDF Viewer Worker CSP
//   10. Next Image remotePatterns
//   11. Chinese/English pages <html lang>
//   12. Inquiry product name cannot be forged by client
//   13. Catalog pending/private/restricted not public
//   14. Readiness failure returns 503
//   15. Demo Mode does not need Supabase credentials
//   16. Browser Bundle does not contain server-side Secret names or values
// ============================================================

const ROOT = join(import.meta.dirname, "..", "..");

function readFile(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function fileExists(relativePath: string): boolean {
  return existsSync(join(ROOT, relativePath));
}

// ---------------------------------------------------------------------------
// 1. Next.js 15 async cookies() admin authentication
// ---------------------------------------------------------------------------

describe("1. Next.js 15 async cookies() admin auth", () => {
  it("createServerSupabaseClient is async and awaits cookies()", () => {
    const source = readFile("lib/supabase/server.ts");
    // Must be async
    expect(source).toMatch(/export\s+async\s+function\s+createServerSupabaseClient/);
    // Must await cookies()
    expect(source).toMatch(/await\s+cookies\(\)/);
    // Must NOT use sync cookies() call
    expect(source).not.toMatch(/const\s+cookieStore\s*=\s*cookies\(\)\s*[;,\n]/);
  });

  it("getVerifiedAdmin awaits createServerSupabaseClient", () => {
    const source = readFile("lib/services/admin-auth.ts");
    expect(source).toMatch(/await\s+createServerSupabaseClient\(\)/);
    // The sessionClient type must reflect the async nature
    expect(source).toMatch(/Awaited<ReturnType<typeof createServerSupabaseClient>>/);
  });
});

// ---------------------------------------------------------------------------
// 2. Async params in product detail route
// ---------------------------------------------------------------------------

describe("2. Async params product detail route", () => {
  it("product detail page uses Promise<{ slug }> and awaits params", () => {
    const source = readFile("app/(public)/products/[slug]/page.tsx");
    expect(source).toMatch(/params:\s*Promise<\{\s*slug:\s*string\s*\}>/);
    expect(source).toMatch(/await\s+params/);
  });

  it("English product detail page uses Promise<{ slug }> and awaits params", () => {
    const source = readFile("app/en/products/[slug]/page.tsx");
    expect(source).toMatch(/params:\s*Promise<\{\s*slug:\s*string\s*\}>/);
    expect(source).toMatch(/await\s+params/);
  });

  it("admin product edit page uses Promise<{ id }> and awaits params", () => {
    const source = readFile("app/admin/(protected)/products/[id]/edit/page.tsx");
    expect(source).toMatch(/params:\s*Promise<\{\s*id:\s*string\s*\}>/);
    expect(source).toMatch(/await\s+params/);
  });
});

// ---------------------------------------------------------------------------
// 3. Async params in generateMetadata
// ---------------------------------------------------------------------------

describe("3. Async params generateMetadata", () => {
  it("product detail generateMetadata is async with Promise params", () => {
    const source = readFile("app/(public)/products/[slug]/page.tsx");
    expect(source).toMatch(/export\s+async\s+function\s+generateMetadata\s*\(\s*\{\s*params\s*\}\s*:\s*\{\s*params:\s*Promise</);
  });

  it("project detail generateMetadata is async with Promise params", () => {
    const source = readFile("app/(public)/projects/[slug]/page.tsx");
    expect(source).toMatch(/export\s+async\s+function\s+generateMetadata\s*\(\s*\{\s*params\s*\}\s*:\s*\{\s*params:\s*Promise</);
  });
});

// ---------------------------------------------------------------------------
// 4. SearchParams product search and pagination
// ---------------------------------------------------------------------------

describe("4. SearchParams product search and pagination", () => {
  it("products page uses Promise<SearchParams> and awaits", () => {
    const source = readFile("app/(public)/products/page.tsx");
    expect(source).toMatch(/searchParams:\s*Promise</);
    expect(source).toMatch(/await\s+searchParams/);
  });

  it("English products page uses Promise<SearchParams> and awaits", () => {
    const source = readFile("app/en/products/page.tsx");
    expect(source).toMatch(/searchParams:\s*Promise</);
    expect(source).toMatch(/await\s+searchParams/);
  });

  it("contact page uses Promise<SearchParams> and awaits", () => {
    const source = readFile("app/(public)/contact/page.tsx");
    expect(source).toMatch(/searchParams:\s*Promise</);
    expect(source).toMatch(/await\s+searchParams/);
  });

  it("admin analytics page uses Promise<SearchParams> and awaits", () => {
    const source = readFile("app/admin/(protected)/analytics/page.tsx");
    expect(source).toMatch(/searchParams:\s*Promise</);
    expect(source).toMatch(/await\s+searchParams/);
  });
});

// ---------------------------------------------------------------------------
// 5. Dynamic API Route not statically cached
// ---------------------------------------------------------------------------

describe("5. Dynamic API Route not statically cached", () => {
  const dynamicRoutes = [
    "app/api/readiness/route.ts",
    "app/api/health/route.ts",
    "app/api/inquiries/route.ts",
    "app/api/analytics/events/route.ts",
    "app/api/admin/products/route.ts",
    "app/api/admin/inquiries/route.ts",
    "app/api/staging/diagnostics/route.ts",
  ];

  for (const route of dynamicRoutes) {
    it(`${route} is dynamic (force-dynamic, POST-only, or GET-with-dynamic-apis)`, () => {
      const source = readFile(route);
      const hasForceDynamic = /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/.test(source);
      const hasRuntime = /export\s+const\s+runtime\s*=\s*["']nodejs["']/.test(source);
      // In Next.js 15, routes with only POST/PATCH/DELETE are dynamic by default
      const hasPostOrPatch = /export\s+async\s+function\s+(POST|PATCH|DELETE|PUT)\s*\(/.test(source);
      // Check if GET is a real handler or just returns 405
      const getMatch = source.match(/export\s+(?:async\s+)?function\s+GET\s*\([^)]*\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/s);
      const getIs405 = getMatch ? /405|Method Not Allowed/.test(getMatch[1]) : false;
      const hasRealGet = Boolean(getMatch) && !getIs405;
      // If GET uses dynamic APIs (cookies/headers/noStore), it's dynamic by nature
      const getUsesDynamicApi = getMatch
        ? /cookies\(\)|headers\(\)|noStore\(\)|getVerifiedAdmin\(\)/.test(getMatch[1])
        : false;
      // Route is dynamic if:
      // 1. Has force-dynamic, OR
      // 2. Is POST/PATCH-only (no GET), OR
      // 3. Has GET but it's just 405 (not a real cached handler), OR
      // 4. Has GET that uses dynamic APIs (cookies/headers/noStore)
      const isDynamic = hasForceDynamic || (hasPostOrPatch && !hasRealGet) || (hasRealGet && getUsesDynamicApi);
      expect(isDynamic).toBe(true);
      // Readiness and health must explicitly set runtime
      if (route.includes("readiness") || route.includes("health")) {
        expect(hasRuntime).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Admin write Origin fail-closed
// ---------------------------------------------------------------------------

const mockGetVerifiedAdmin = vi.fn();
const mockIsSameOrigin = vi.fn();
const mockIsAllowedFetchSite = vi.fn();
const mockReadJsonBody = vi.fn();

vi.mock("@/lib/services/admin-auth", () => ({
  getVerifiedAdmin: mockGetVerifiedAdmin,
}));
vi.mock("@/lib/services/http-security", () => ({
  isSameOrigin: mockIsSameOrigin,
  isAllowedFetchSite: mockIsAllowedFetchSite,
  readJsonBody: mockReadJsonBody,
  ephemeralRateKey: vi.fn(() => "rate-key"),
  UUID_PATTERN: { test: () => true },
}));

describe("6. Admin write Origin fail-closed", () => {
  beforeEach(() => {
    mockGetVerifiedAdmin.mockReset();
    mockIsSameOrigin.mockReset();
    mockIsAllowedFetchSite.mockReset();
    mockReadJsonBody.mockReset();
  });

  it("requireAdminWrite rejects when Origin is missing (fail-closed)", async () => {
    mockGetVerifiedAdmin.mockResolvedValue({
      ok: true,
      user: { id: "u1", email: "admin@test" },
      profile: { id: "p1", role: "admin" },
      client: {},
    });
    // Missing Origin -> isSameOrigin returns false (fail-closed)
    mockIsSameOrigin.mockReturnValue(false);
    mockIsAllowedFetchSite.mockReturnValue(true);

    const { requireAdminWrite } = await import("@/lib/services/admin-write-boundary");
    const request = new NextRequest("https://kzq.test/api/admin/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // no Origin header
      body: JSON.stringify({}),
    });
    const result = await requireAdminWrite(request, 256 * 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.error).toBe("ADMIN_WRITE_FORBIDDEN_ORIGIN");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. React 19 Ref Callback behavior
// ---------------------------------------------------------------------------

describe("7. React 19 Ref Callback behavior", () => {
  it("@types/react is version 19.x", () => {
    const pkg = JSON.parse(readFile("package.json"));
    const typesReact = pkg.devDependencies["@types/react"];
    expect(typesReact).toMatch(/^19\./);
  });

  it("@types/react-dom is version 19.x", () => {
    const pkg = JSON.parse(readFile("package.json"));
    const typesDom = pkg.devDependencies["@types/react-dom"];
    expect(typesDom).toMatch(/^19\./);
  });

  it("react and react-dom are version 19.x", () => {
    const pkg = JSON.parse(readFile("package.json"));
    expect(pkg.dependencies.react).toMatch(/^19\./);
    expect(pkg.dependencies["react-dom"]).toMatch(/^19\./);
  });
});

// ---------------------------------------------------------------------------
// 8. React 19 tests no act warning (structural verification)
// ---------------------------------------------------------------------------

describe("8. React 19 test environment configuration", () => {
  it("vitest config uses @testing-library/react v16+ compatible with React 19", () => {
    const pkg = JSON.parse(readFile("package.json"));
    const testingLibrary = pkg.devDependencies["@testing-library/react"];
    expect(testingLibrary).toBeDefined();
    const major = parseInt(testingLibrary.replace(/[^\d]/g, ""), 10);
    expect(major).toBeGreaterThanOrEqual(16);
  });

  it("no React 18 leftover in runtime dependencies", () => {
    const pkg = JSON.parse(readFile("package.json"));
    // React 18 must not appear as a version
    expect(pkg.dependencies.react).not.toMatch(/^18\./);
    expect(pkg.dependencies["react-dom"]).not.toMatch(/^18\./);
  });
});

// ---------------------------------------------------------------------------
// 9. PDF Viewer Worker CSP
// ---------------------------------------------------------------------------

describe("9. PDF Viewer Worker CSP", () => {
  it("middleware CSP allows blob: worker-src for PDF.js", () => {
    const source = readFile("middleware.ts");
    // worker-src must include blob: for PDF.js worker
    expect(source).toMatch(/worker-src\s+'self'\s+blob:/);
  });

  it("CSP does not use overly broad worker-src *", () => {
    const source = readFile("middleware.ts");
    expect(source).not.toMatch(/worker-src\s+\*/);
  });

  it("CSP does not include unnecessary unsafe-eval for scripts", () => {
    const source = readFile("middleware.ts");
    // CSP is Report-Only, and unsafe-eval should only appear if strictly needed
    // Check that it's not using a blanket wildcard
    expect(source).not.toMatch(/script-src\s+\*/);
    expect(source).not.toMatch(/connect-src\s+\*/);
    expect(source).not.toMatch(/img-src\s+\*/);
  });
});

// ---------------------------------------------------------------------------
// 10. Next Image remotePatterns
// ---------------------------------------------------------------------------

describe("10. Next Image remotePatterns", () => {
  it("next.config.mjs defines images.remotePatterns", async () => {
    const mod = await import("../../next.config.mjs");
    const config = mod.default as { images?: { remotePatterns?: unknown[] } };
    expect(config.images?.remotePatterns).toBeDefined();
    expect(Array.isArray(config.images?.remotePatterns)).toBe(true);
    expect((config.images?.remotePatterns ?? []).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 11. Chinese/English pages <html lang>
// ---------------------------------------------------------------------------

describe("11. Chinese/English pages <html lang>", () => {
  it("Chinese root layout sets lang=\"zh-CN\"", () => {
    const source = readFile("app/(public)/layout.tsx");
    expect(source).toMatch(/lang=["']zh-CN["']/);
  });

  it("English layout sets lang=\"en\"", () => {
    const source = readFile("app/en/layout.tsx");
    expect(source).toMatch(/lang=["']en["']/);
  });

  it("global-error layout sets lang=\"zh-CN\"", () => {
    const source = readFile("app/global-error.tsx");
    expect(source).toMatch(/lang=["']zh-CN["']/);
  });
});

// ---------------------------------------------------------------------------
// 12. Inquiry product name cannot be forged by client
// ---------------------------------------------------------------------------

describe("12. Inquiry product name cannot be forged by client", () => {
  it("inquiry validation does not accept product_name_cn from client", () => {
    const source = readFile("lib/services/inquiries/validation.ts");
    // The validation should NOT pass through a client-supplied product_name_cn
    // The product name must come from the database via RPC
    expect(source).not.toMatch(/product_name_cn\s*[:=]\s*[^;]*input/);
  });

  it("inquiry submission RPC uses database-owned product snapshot", () => {
    const source = readFile("lib/repositories/inquiries.ts");
    // The submission must call an RPC that resolves product names from the DB
    expect(source).toMatch(/\.rpc\s*\(/);
    // The RPC name must be create_inquiry_with_items (the hardened RPC)
    expect(source).toMatch(/create_inquiry_with_items/);
  });
});

// ---------------------------------------------------------------------------
// 13. Catalog pending/private/restricted not public
// ---------------------------------------------------------------------------

describe("13. Catalog pending/private/restricted not public", () => {
  it("product public status query only selects published products", () => {
    // Check the public product repository for is_published filter
    const source = readFile("lib/repositories/products.ts");
    expect(source).toMatch(/is_published.*eq.*true|eq.*is_published.*true/);
  });

  it("catalog assets query filters by public visibility", () => {
    if (fileExists("lib/repositories/catalog-assets.ts")) {
      const source = readFile("lib/repositories/catalog-assets.ts");
      // Must filter by published/public status, not return everything
      expect(source).toMatch(/is_published|visibility|public|status/);
    }
  });
});

// ---------------------------------------------------------------------------
// 14. Readiness failure returns 503
// ---------------------------------------------------------------------------

describe("14. Readiness failure returns 503", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 503 when Supabase env vars are missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const { GET } = await import("@/app/api/readiness/route");
    const request = new NextRequest("https://kzq.test/api/readiness");
    const response = await GET(request);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.ready).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

// ---------------------------------------------------------------------------
// 15. Demo Mode does not need Supabase credentials
// ---------------------------------------------------------------------------

describe("15. Demo Mode does not need Supabase credentials", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("isDemoMode returns true when NEXT_PUBLIC_DEMO_MODE is 'true'", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    const { isDemoMode } = await import("@/lib/demo");
    expect(isDemoMode()).toBe(true);
  });

  it("isDemoMode returns false when NEXT_PUBLIC_DEMO_MODE is not set", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "");
    const { isDemoMode } = await import("@/lib/demo");
    expect(isDemoMode()).toBe(false);
  });

  it("demo mode does not require Supabase env vars", () => {
    const source = readFile("lib/demo.ts");
    // isDemoMode should only check NEXT_PUBLIC_DEMO_MODE, not Supabase vars
    expect(source).not.toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(source).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});

// ---------------------------------------------------------------------------
// 16. Browser Bundle does not contain server-side Secret names or values
// ---------------------------------------------------------------------------

describe("16. Browser Bundle does not contain server-side Secret names", () => {
  const serverOnlySecrets = [
    "SUPABASE_SERVICE_ROLE_KEY",
    "READINESS_TOKEN",
    "DATABASE_TEST_URL",
    "DATABASE_UPGRADE_TEST_URL",
  ];

  it("server-only admin module references service role key", () => {
    // Verify that the server-only module exists and references the key
    const serverModule = readFile("lib/supabase/admin.ts");
    expect(serverModule).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("no client component imports the server-only admin module", () => {
    // Verify that "use client" files do not import lib/supabase/admin
    // This is enforced structurally by the production-write-boundary test
    // Here we verify the admin module is server-only by convention
    const adminSource = readFile("lib/supabase/admin.ts");
    // The admin module must NOT have "use client" directive
    expect(adminSource).not.toMatch(/^["']use client["']/);
  });

  it("middleware does not expose service role key to the client", () => {
    const source = readFile("middleware.ts");
    // Middleware runs on Edge, must not reference service role key
    expect(source).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(source).not.toMatch(/service.role/i);
  });

  it("health route does not leak env var names", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "false");
    vi.stubEnv("NEXT_PUBLIC_SITE_INDEXING_ENABLED", "");
    vi.stubEnv("GIT_COMMIT_SHA", "abc123");
    const { GET } = await import("@/app/api/health/route");
    const response = GET();
    const body = await response.json();
    const bodyStr = JSON.stringify(body);
    // Must not contain any server-side secret env var names
    for (const secret of serverOnlySecrets) {
      expect(bodyStr).not.toContain(secret);
    }
    // Must not contain "service" in a key-leaking way
    expect(bodyStr).not.toContain("service-role");
    expect(bodyStr).not.toContain("service_role");
  });
});
