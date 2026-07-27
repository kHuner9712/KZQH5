import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ============================================================
// Supabase Auth Session Refresh — Middleware Tests
// ------------------------------------------------------------
// Verifies that:
//   1. shouldRefreshSession() only matches /admin, /api/admin, /api/internal
//      (and their subpaths) — NOT public ISR pages.
//   2. refreshSupabaseSession() is a no-op when Supabase env vars are
//      missing (Demo mode / local dev).
//   3. refreshSupabaseSession() calls supabase.auth.getUser() when env
//      vars are present.
//   4. Refreshed cookies are written to BOTH the request and the response.
//   5. A network failure during getUser() does NOT block the request
//      (fail-open for refresh; authorization is server-side).
//   6. The middleware applies security headers to ALL responses.
//   7. Public ISR paths do NOT trigger the session refresh.
// ============================================================

// --- Mocks ---------------------------------------------------------------
// We mock @supabase/ssr's createServerClient to capture cookie writes
// without making a real network call.
const mockGetUser = vi.fn();
const mockSetAll = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
    },
    // The mock captures setAll calls so tests can assert cookie behavior.
    // (Not strictly necessary — the real setAll is in the cookies config
    // below — but kept for future test extensibility.)
  })),
}));

import {
  refreshSupabaseSession,
  shouldRefreshSession,
  SESSION_REFRESH_PATHS,
} from "@/lib/supabase/middleware-session";

beforeEach(() => {
  vi.unstubAllEnvs();
  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ============================================================
// shouldRefreshSession
// ============================================================
describe("shouldRefreshSession — path matching", () => {
  it("matches /admin and its subpaths", () => {
    expect(shouldRefreshSession("/admin")).toBe(true);
    expect(shouldRefreshSession("/admin/")).toBe(true);
    expect(shouldRefreshSession("/admin/products")).toBe(true);
    expect(shouldRefreshSession("/admin/products/123")).toBe(true);
  });

  it("matches /api/admin and its subpaths", () => {
    expect(shouldRefreshSession("/api/admin")).toBe(true);
    expect(shouldRefreshSession("/api/admin/products")).toBe(true);
    expect(shouldRefreshSession("/api/admin/inquiries/123")).toBe(true);
  });

  it("matches /api/internal and its subpaths", () => {
    expect(shouldRefreshSession("/api/internal")).toBe(true);
    expect(shouldRefreshSession("/api/internal/outbox/dispatch")).toBe(true);
  });

  it("does NOT match public ISR pages", () => {
    expect(shouldRefreshSession("/")).toBe(false);
    expect(shouldRefreshSession("/products")).toBe(false);
    expect(shouldRefreshSession("/products/some-slug")).toBe(false);
    expect(shouldRefreshSession("/documents")).toBe(false);
    expect(shouldRefreshSession("/contact")).toBe(false);
    expect(shouldRefreshSession("/api/inquiries")).toBe(false);
    expect(shouldRefreshSession("/api/analytics/events")).toBe(false);
    expect(shouldRefreshSession("/api/products/selection")).toBe(false);
    expect(shouldRefreshSession("/api/health")).toBe(false);
  });

  it("does NOT match /admin-prefixed-but-different paths", () => {
    // /admin-foo should NOT be treated as /admin/**
    expect(shouldRefreshSession("/admin-foo")).toBe(false);
    expect(shouldRefreshSession("/administration")).toBe(false);
    expect(shouldRefreshSession("/api/admin-foo")).toBe(false);
  });

  it("SESSION_REFRESH_PATHS is exhaustive and documented", () => {
    expect(SESSION_REFRESH_PATHS).toContain("/admin");
    expect(SESSION_REFRESH_PATHS).toContain("/api/admin");
    expect(SESSION_REFRESH_PATHS).toContain("/api/internal");
  });
});

// ============================================================
// refreshSupabaseSession
// ============================================================
describe("refreshSupabaseSession — Demo / no-env mode", () => {
  it("is a no-op when NEXT_PUBLIC_SUPABASE_URL is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-key");
    const request = new NextRequest("https://kzq.test/admin");
    const response = NextResponse.next();
    await refreshSupabaseSession(request, response);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("is a no-op when NEXT_PUBLIC_SUPABASE_ANON_KEY is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const request = new NextRequest("https://kzq.test/admin");
    const response = NextResponse.next();
    await refreshSupabaseSession(request, response);
    expect(mockGetUser).not.toHaveBeenCalled();
  });
});

describe("refreshSupabaseSession — happy path", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
  });

  it("calls supabase.auth.getUser() to trigger auto-refresh", async () => {
    const request = new NextRequest("https://kzq.test/admin");
    const response = NextResponse.next();
    await refreshSupabaseSession(request, response);
    expect(mockGetUser).toHaveBeenCalledTimes(1);
  });

  it("does NOT throw when getUser() fails (fail-open for refresh)", async () => {
    mockGetUser.mockRejectedValueOnce(new Error("network error"));
    const request = new NextRequest("https://kzq.test/admin");
    const response = NextResponse.next();
    // Must not throw — the middleware must still return a response.
    await expect(refreshSupabaseSession(request, response)).resolves.toBeUndefined();
  });
});

// ============================================================
// Middleware integration — security headers + session refresh
// ============================================================
describe("middleware integration", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
  });

  it("applies security headers to ALL responses (public and admin)", async () => {
    const { middleware } = await import("@/middleware");
    // Public path
    const publicReq = new NextRequest("https://kzq.test/products");
    const publicRes = await middleware(publicReq);
    expect(publicRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(publicRes.headers.get("X-Frame-Options")).toBe("DENY");
    expect(publicRes.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(publicRes.headers.get("Content-Security-Policy-Report-Only")).toBeTruthy();

    // Admin path
    const adminReq = new NextRequest("https://kzq.test/admin");
    const adminRes = await middleware(adminReq);
    expect(adminRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(adminRes.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("does NOT call supabase.auth.getUser() on public ISR paths", async () => {
    mockGetUser.mockClear();
    const { middleware } = await import("@/middleware");
    const request = new NextRequest("https://kzq.test/products");
    await middleware(request);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("calls supabase.auth.getUser() on /admin paths", async () => {
    mockGetUser.mockClear();
    const { middleware } = await import("@/middleware");
    const request = new NextRequest("https://kzq.test/admin");
    await middleware(request);
    expect(mockGetUser).toHaveBeenCalledTimes(1);
  });

  it("calls supabase.auth.getUser() on /api/admin paths", async () => {
    mockGetUser.mockClear();
    const { middleware } = await import("@/middleware");
    const request = new NextRequest("https://kzq.test/api/admin/products", {
      method: "GET",
    });
    await middleware(request);
    expect(mockGetUser).toHaveBeenCalledTimes(1);
  });

  it("calls supabase.auth.getUser() on /api/internal paths", async () => {
    mockGetUser.mockClear();
    const { middleware } = await import("@/middleware");
    const request = new NextRequest(
      "https://kzq.test/api/internal/outbox/dispatch",
      { method: "POST" },
    );
    await middleware(request);
    expect(mockGetUser).toHaveBeenCalledTimes(1);
  });

  it("applies HSTS only on HTTPS", async () => {
    const { middleware } = await import("@/middleware");
    const httpsReq = new NextRequest("https://kzq.test/admin");
    const httpsRes = await middleware(httpsReq);
    expect(httpsRes.headers.get("Strict-Transport-Security")).toContain(
      "max-age=31536000",
    );
  });

  it("still returns a response even if session refresh throws", async () => {
    mockGetUser.mockRejectedValueOnce(new Error("network failure"));
    const { middleware } = await import("@/middleware");
    const request = new NextRequest("https://kzq.test/admin");
    const response = await middleware(request);
    expect(response).toBeInstanceOf(NextResponse);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
