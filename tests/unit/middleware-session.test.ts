import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ============================================================
// Supabase Auth Session Refresh — Edge-Compatible Middleware Tests
// ------------------------------------------------------------
// Verifies that:
//   1. shouldRefreshSession() only matches /admin, /api/admin, /api/internal
//      (and their subpaths) — NOT public ISR pages.
//   2. refreshSupabaseSession() is a no-op (returns original response
//      unchanged) when Supabase env vars are missing (Demo mode / local dev).
//   3. refreshSupabaseSession() calls the Supabase Auth refresh-token
//      endpoint via fetch() when the access token is near expiry.
//   4. Refreshed cookies are written to BOTH the request and the
//      returned response (Set-Cookie header present).
//   5. When cookies were refreshed:
//        a. The returned response is a NEW NextResponse (not the original).
//        b. `Cache-Control: private, no-store` is set.
//        c. All security headers from the original response are preserved.
//        d. Cookies the caller set on the original response are preserved.
//        e. The downstream request sees the rotated cookies.
//   6. When NO cookie was refreshed, the original response is returned
//      unchanged (no Cache-Control mutation, no extra response churn).
//   7. A network failure during refresh does NOT block the request
//      (fail-open for refresh; authorization is server-side). The
//      original response is returned.
//   8. The middleware applies security headers to ALL responses.
//   9. Public ISR paths do NOT trigger the session refresh (no fetch call).
//  10. The module does NOT import @supabase/ssr or @supabase/supabase-js
//      (Edge Runtime compatibility).
// ============================================================

// --- Mocks ---------------------------------------------------------------
// We mock global fetch to simulate the Supabase Auth refresh-token
// endpoint. The mock is reset before each test.
const mockFetch = vi.fn();

beforeEach(() => {
  vi.unstubAllEnvs();
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/**
 * Build a valid Supabase auth cookie value (base64-prefixed JSON)
 * for the given session fields.
 */
function encodeSessionCookie(session: {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
}): string {
  const json = JSON.stringify(session);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `base64-${base64}`;
}

/**
 * Configure mockFetch to simulate a successful token refresh.
 * Returns the new session that the refresh endpoint "sent back".
 */
function simulateSuccessfulRefresh(newSession: {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: number;
}) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => newSession,
  });
}

const TEST_SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
const TEST_ANON_KEY = "test-anon-key";
const TEST_COOKIE_NAME = "sb-abcdefghijklmnopqrst-auth-token";

import {
  refreshSupabaseSession,
  shouldRefreshSession,
  SESSION_REFRESH_PATHS,
} from "@/lib/supabase/middleware-session";

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
// refreshSupabaseSession — Demo / no-env mode
// ============================================================
describe("refreshSupabaseSession — Demo / no-env mode", () => {
  it("returns the original response unchanged when NEXT_PUBLIC_SUPABASE_URL is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-key");
    const request = new NextRequest("https://kzq.test/admin");
    const response = NextResponse.next();
    response.headers.set("X-Content-Type-Options", "nosniff");
    const result = await refreshSupabaseSession(request, response);
    expect(result).toBe(response);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.headers.get("Cache-Control")).toBeNull();
    expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("returns the original response unchanged when NEXT_PUBLIC_SUPABASE_ANON_KEY is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const request = new NextRequest("https://kzq.test/admin");
    const response = NextResponse.next();
    const result = await refreshSupabaseSession(request, response);
    expect(result).toBe(response);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns the original response unchanged for non-canonical Supabase URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:5433");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-key");
    const request = new NextRequest("https://kzq.test/admin");
    const response = NextResponse.next();
    const result = await refreshSupabaseSession(request, response);
    expect(result).toBe(response);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ============================================================
// refreshSupabaseSession — no refresh needed
// ============================================================
describe("refreshSupabaseSession — no refresh needed", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", TEST_ANON_KEY);
  });

  it("returns the original response unchanged when no session cookie is present", async () => {
    const request = new NextRequest("https://kzq.test/admin");
    const response = NextResponse.next();
    response.headers.set("X-Content-Type-Options", "nosniff");
    const result = await refreshSupabaseSession(request, response);
    expect(result).toBe(response);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.headers.get("Cache-Control")).toBeNull();
  });

  it("returns the original response unchanged when the access token is still valid", async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    const cookieValue = encodeSessionCookie({
      access_token: "valid-token",
      refresh_token: "valid-refresh",
      expires_at: futureExpiry,
    });
    const request = new NextRequest("https://kzq.test/admin", {
      headers: { Cookie: `${TEST_COOKIE_NAME}=${cookieValue}` },
    });
    const response = NextResponse.next();
    response.headers.set("X-Content-Type-Options", "nosniff");
    const result = await refreshSupabaseSession(request, response);
    expect(result).toBe(response);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.headers.get("Cache-Control")).toBeNull();
  });

  it("returns the original response unchanged for corrupted session cookie", async () => {
    const request = new NextRequest("https://kzq.test/admin", {
      headers: { Cookie: `${TEST_COOKIE_NAME}=not-valid-json` },
    });
    const response = NextResponse.next();
    const result = await refreshSupabaseSession(request, response);
    expect(result).toBe(response);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ============================================================
// refreshSupabaseSession — cookie refresh path
// ============================================================
describe("refreshSupabaseSession — cookie refresh", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", TEST_ANON_KEY);
  });

  function buildRequestWithExpiringToken(): NextRequest {
    const pastExpiry = Math.floor(Date.now() / 1000) - 10;
    const cookieValue = encodeSessionCookie({
      access_token: "expiring-token",
      refresh_token: "valid-refresh-token",
      expires_at: pastExpiry,
    });
    return new NextRequest("https://kzq.test/admin", {
      headers: { Cookie: `${TEST_COOKIE_NAME}=${cookieValue}` },
    });
  }

  it("calls the Supabase Auth refresh endpoint when the token is near expiry", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
    });
    const request = buildRequestWithExpiringToken();
    await refreshSupabaseSession(request, NextResponse.next());
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/auth/v1/token?grant_type=refresh_token");
    expect(options.method).toBe("POST");
    expect(options.headers.apikey).toBe(TEST_ANON_KEY);
    expect(options.headers.Authorization).toBe("Bearer expiring-token");
    const body = JSON.parse(options.body);
    expect(body.refresh_token).toBe("valid-refresh-token");
  });

  it("returns a NEW NextResponse (not the original) when cookies were refreshed", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    const request = buildRequestWithExpiringToken();
    const original = NextResponse.next();
    const result = await refreshSupabaseSession(request, original);
    expect(result).not.toBe(original);
    expect(result).toBeInstanceOf(NextResponse);
  });

  it("writes Set-Cookie on the returned response with the rotated value", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    const request = buildRequestWithExpiringToken();
    const original = NextResponse.next();
    const result = await refreshSupabaseSession(request, original);
    const setCookie = result.headers.get("Set-Cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain(TEST_COOKIE_NAME);
  });

  it("forwards the rotated cookie to the downstream request", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    const request = buildRequestWithExpiringToken();
    await refreshSupabaseSession(request, NextResponse.next());
    // The downstream handler reading request.cookies should see a cookie
    // with the new encoded session value.
    const cookie = request.cookies.get(TEST_COOKIE_NAME);
    expect(cookie).toBeTruthy();
    expect(cookie!.value).toContain("base64-");
  });

  it("sets Cache-Control: private, no-store on the returned response", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    const request = buildRequestWithExpiringToken();
    const original = NextResponse.next();
    const result = await refreshSupabaseSession(request, original);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("preserves all security headers from the original response", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    const request = buildRequestWithExpiringToken();
    const original = NextResponse.next();
    original.headers.set("X-Content-Type-Options", "nosniff");
    original.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    original.headers.set("X-Frame-Options", "DENY");
    original.headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    original.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
    original.headers.set(
      "Content-Security-Policy-Report-Only",
      "default-src 'self'",
    );

    const result = await refreshSupabaseSession(request, original);

    expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(result.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(result.headers.get("X-Frame-Options")).toBe("DENY");
    expect(result.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
    expect(result.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(result.headers.get("Content-Security-Policy-Report-Only")).toBe(
      "default-src 'self'",
    );
  });

  it("preserves cookies the caller already set on the original response", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    const request = buildRequestWithExpiringToken();
    const original = NextResponse.next();
    original.cookies.set("caller-cookie", "caller-value", {
      httpOnly: true,
      path: "/",
    });

    const result = await refreshSupabaseSession(request, original);

    const setCookieHeader = result.headers.get("Set-Cookie");
    expect(setCookieHeader).toContain("caller-cookie=caller-value");
  });

  it("does NOT throw when fetch fails (fail-open for refresh)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));
    const request = buildRequestWithExpiringToken();
    const response = NextResponse.next();
    response.headers.set("X-Content-Type-Options", "nosniff");
    await expect(refreshSupabaseSession(request, response)).resolves.toBe(
      response,
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBeNull();
  });

  it("does NOT throw when refresh endpoint returns HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "invalid_grant" }),
    });
    const request = buildRequestWithExpiringToken();
    const response = NextResponse.next();
    await expect(refreshSupabaseSession(request, response)).resolves.toBe(
      response,
    );
    expect(response.headers.get("Cache-Control")).toBeNull();
  });
});

// ============================================================
// Edge Runtime compatibility
// ============================================================
describe("Edge Runtime compatibility", () => {
  it("does NOT import @supabase/ssr or @supabase/supabase-js", async () => {
    // Read the module source and verify no banned imports.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const modulePath = path.resolve(
      process.cwd(),
      "lib/supabase/middleware-session.ts",
    );
    const source = fs.readFileSync(modulePath, "utf8");
    expect(source).not.toMatch(/from\s+["']@supabase\/ssr["']/);
    expect(source).not.toMatch(/from\s+["']@supabase\/supabase-js["']/);
    expect(source).not.toMatch(/createServerClient/);
    expect(source).not.toMatch(/createClient/);
  });
});

// ============================================================
// Middleware integration — security headers + session refresh
// ============================================================
describe("middleware integration", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", TEST_ANON_KEY);
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

  it("does NOT call fetch on public ISR paths", async () => {
    const { middleware } = await import("@/middleware");
    const request = new NextRequest("https://kzq.test/products");
    await middleware(request);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does NOT call fetch on /admin when no session cookie is present", async () => {
    const { middleware } = await import("@/middleware");
    const request = new NextRequest("https://kzq.test/admin");
    await middleware(request);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does NOT call fetch on /admin when the token is still valid", async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    const cookieValue = encodeSessionCookie({
      access_token: "valid-token",
      refresh_token: "valid-refresh",
      expires_at: futureExpiry,
    });
    const { middleware } = await import("@/middleware");
    const request = new NextRequest("https://kzq.test/admin", {
      headers: { Cookie: `${TEST_COOKIE_NAME}=${cookieValue}` },
    });
    await middleware(request);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("calls fetch on /admin when the token is near expiry", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    const pastExpiry = Math.floor(Date.now() / 1000) - 10;
    const cookieValue = encodeSessionCookie({
      access_token: "expiring-token",
      refresh_token: "valid-refresh",
      expires_at: pastExpiry,
    });
    const { middleware } = await import("@/middleware");
    const request = new NextRequest("https://kzq.test/admin", {
      headers: { Cookie: `${TEST_COOKIE_NAME}=${cookieValue}` },
    });
    await middleware(request);
    expect(mockFetch).toHaveBeenCalledTimes(1);
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
    mockFetch.mockRejectedValueOnce(new Error("network failure"));
    const pastExpiry = Math.floor(Date.now() / 1000) - 10;
    const cookieValue = encodeSessionCookie({
      access_token: "expiring-token",
      refresh_token: "valid-refresh",
      expires_at: pastExpiry,
    });
    const { middleware } = await import("@/middleware");
    const request = new NextRequest("https://kzq.test/admin", {
      headers: { Cookie: `${TEST_COOKIE_NAME}=${cookieValue}` },
    });
    const response = await middleware(request);
    expect(response).toBeInstanceOf(NextResponse);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBeNull();
  });

  it("returns a response with Cache-Control: private, no-store when cookies are refreshed via middleware", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access-via-middleware",
      refresh_token: "new-refresh-via-middleware",
      expires_in: 3600,
    });
    const pastExpiry = Math.floor(Date.now() / 1000) - 10;
    const cookieValue = encodeSessionCookie({
      access_token: "expiring-token",
      refresh_token: "valid-refresh",
      expires_at: pastExpiry,
    });
    const { middleware } = await import("@/middleware");
    const request = new NextRequest("https://kzq.test/admin", {
      headers: { Cookie: `${TEST_COOKIE_NAME}=${cookieValue}` },
    });
    const response = await middleware(request);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Set-Cookie")).toContain(TEST_COOKIE_NAME);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("does NOT set Cache-Control: private, no-store on public ISR paths", async () => {
    const { middleware } = await import("@/middleware");
    const request = new NextRequest("https://kzq.test/products");
    const response = await middleware(request);
    expect(response.headers.get("Cache-Control")).toBeNull();
  });
});
