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
    // WP4: The refresh endpoint must NOT depend on the old (possibly
    // expired) access token. Only apikey + refresh_token in the body.
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.headers["Content-Type"]).toBe("application/json");
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

  it("sets full anti-cache headers on the returned response (WP3)", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    const request = buildRequestWithExpiringToken();
    const original = NextResponse.next();
    const result = await refreshSupabaseSession(request, original);
    // WP3: Full anti-cache header set matching @supabase/ssr's
    // applyServerStorage behavior.
    expect(result.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
    expect(result.headers.get("Expires")).toBe("0");
    expect(result.headers.get("Pragma")).toBe("no-cache");
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

  it("returns a response with full anti-cache headers when cookies are refreshed via middleware (WP3)", async () => {
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
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
    expect(response.headers.get("Expires")).toBe("0");
    expect(response.headers.get("Pragma")).toBe("no-cache");
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

// ============================================================
// WP1: Persistent absolute expires_at
// ============================================================
describe("WP1: persistent absolute expires_at", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", TEST_ANON_KEY);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  /**
   * Decode the Set-Cookie header(s) from a response and return the
   * session object stored in the auth-token cookie. Returns null if
   * the cookie is not present.
   */
  function decodeSetCookieSession(
    response: NextResponse,
    cookieName: string,
  ): { expires_at?: number; expires_in?: number; access_token: string; refresh_token: string } | null {
    const all = response.cookies.getAll();
    const base = all.find((c) => c.name === cookieName);
    if (base) {
      return decodeSessionValue(base.value);
    }
    const chunks: string[] = [];
    for (let i = 0; ; i++) {
      const c = all.find((x) => x.name === `${cookieName}.${i}`);
      if (!c) break;
      chunks.push(c.value);
    }
    if (chunks.length === 0) return null;
    return decodeSessionValue(chunks.join(""));
  }

  function decodeSessionValue(rawValue: string): {
    expires_at?: number;
    expires_in?: number;
    access_token: string;
    refresh_token: string;
  } | null {
    let jsonStr: string;
    if (rawValue.startsWith("base64-")) {
      try {
        const b64 = rawValue.substring("base64-".length);
        const padded = b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4);
        jsonStr = atob(padded);
        const bytes = new Uint8Array(jsonStr.length);
        for (let i = 0; i < jsonStr.length; i++) bytes[i] = jsonStr.charCodeAt(i);
        jsonStr = new TextDecoder().decode(bytes);
      } catch {
        return null;
      }
    } else {
      jsonStr = rawValue;
    }
    try {
      return JSON.parse(jsonStr);
    } catch {
      return null;
    }
  }

  it("first refresh: persists absolute expires_at = refreshedAt + expires_in", async () => {
    const fixedNow = Math.floor(Date.now() / 1000);
    vi.setSystemTime(fixedNow * 1000);

    // Refresh API returns ONLY expires_in (no expires_at)
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });

    const request = buildRequestWithExpiringToken();
    const result = await refreshSupabaseSession(request, NextResponse.next());

    const session = decodeSetCookieSession(result, TEST_COOKIE_NAME);
    expect(session).not.toBeNull();
    expect(session!.expires_at).toBe(fixedNow + 3600);
    expect(session!.expires_in).toBe(3600);
  });

  it("first refresh: uses body expires_at when present", async () => {
    const fixedNow = Math.floor(Date.now() / 1000);
    vi.setSystemTime(fixedNow * 1000);

    const bodyExpiresAt = fixedNow + 7200;
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      expires_at: bodyExpiresAt,
    });

    const request = buildRequestWithExpiringToken();
    const result = await refreshSupabaseSession(request, NextResponse.next());

    const session = decodeSetCookieSession(result, TEST_COOKIE_NAME);
    expect(session!.expires_at).toBe(bodyExpiresAt);
  });

  it("treats response without expires_at AND without valid expires_in as malformed (fail-open)", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
    });

    const request = buildRequestWithExpiringToken();
    const original = NextResponse.next();
    original.headers.set("X-Test", "preserved");
    const result = await refreshSupabaseSession(request, original);

    expect(result).toBe(original);
    expect(result.headers.get("X-Test")).toBe("preserved");
  });

  it("second refresh: persisted expires_at triggers re-refresh after time advance", async () => {
    // Step 1: First refresh at T0, returns expires_in=3600
    const t0 = 1700000000;
    vi.setSystemTime(t0 * 1000);

    simulateSuccessfulRefresh({
      access_token: "first-access",
      refresh_token: "first-refresh",
      expires_in: 3600,
    });

    const firstRequest = buildRequestWithExpiringToken();
    const firstResult = await refreshSupabaseSession(firstRequest, NextResponse.next());

    const firstSession = decodeSetCookieSession(firstResult, TEST_COOKIE_NAME);
    expect(firstSession!.expires_at).toBe(t0 + 3600);

    // Step 2: Simulate browser applying the Set-Cookie.
    const firstCookieValue = firstResult.cookies
      .getAll()
      .find((c) => c.name === TEST_COOKIE_NAME)?.value;
    expect(firstCookieValue).toBeTruthy();

    // Step 3: Advance time to T0 + 3601 (token now expired)
    const t1 = t0 + 3601;
    vi.setSystemTime(t1 * 1000);

    // Step 4: Second refresh — if expires_at were NOT persisted and
    // instead now + expires_in was recomputed, the token would look
    // fresh (3600s remaining) and refresh would be SKIPPED.
    simulateSuccessfulRefresh({
      access_token: "second-access",
      refresh_token: "second-refresh",
      expires_in: 3600,
    });

    const secondRequest = new NextRequest("https://kzq.test/admin", {
      headers: { Cookie: `${TEST_COOKIE_NAME}=${firstCookieValue}` },
    });
    const secondResult = await refreshSupabaseSession(secondRequest, NextResponse.next());

    expect(mockFetch).toHaveBeenCalledTimes(2);

    const secondSession = decodeSetCookieSession(secondResult, TEST_COOKIE_NAME);
    expect(secondSession!.access_token).toBe("second-access");
    expect(secondSession!.refresh_token).toBe("second-refresh");
    expect(secondSession!.expires_at).toBe(t1 + 3600);
  });

  it("new refresh_token overwrites the old one", async () => {
    vi.setSystemTime(1700000000 * 1000);
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-rotated-refresh",
      expires_in: 3600,
    });

    const request = buildRequestWithExpiringToken();
    const result = await refreshSupabaseSession(request, NextResponse.next());

    const session = decodeSetCookieSession(result, TEST_COOKIE_NAME);
    expect(session!.refresh_token).toBe("new-rotated-refresh");
    expect(session!.refresh_token).not.toBe("valid-refresh-token");
  });
});

// ============================================================
// WP2: Stale cookie chunk deletion in the browser
// ============================================================
describe("WP2: stale cookie chunk deletion in the browser", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", TEST_ANON_KEY);
    vi.useFakeTimers();
    vi.setSystemTime(1700000000 * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function applyResponseToBrowserJar(
    response: NextResponse,
    jar: Map<string, string>,
  ): void {
    for (const cookie of response.cookies.getAll()) {
      if (cookie.maxAge === 0) {
        jar.delete(cookie.name);
      } else {
        jar.set(cookie.name, cookie.value);
      }
    }
  }

  function buildBrowserRequest(
    url: string,
    jar: Map<string, string>,
  ): NextRequest {
    const cookieHeader = Array.from(jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    return new NextRequest(url, {
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    });
  }

  function decodeRawSession(rawValue: string): {
    access_token: string;
    refresh_token: string;
    expires_at?: number;
  } | null {
    let jsonStr: string;
    if (rawValue.startsWith("base64-")) {
      try {
        const b64 = rawValue.substring("base64-".length);
        const padded =
          b64.replace(/-/g, "+").replace(/_/g, "/") +
          "=".repeat((4 - (b64.length % 4)) % 4);
        jsonStr = atob(padded);
        const bytes = new Uint8Array(jsonStr.length);
        for (let i = 0; i < jsonStr.length; i++) bytes[i] = jsonStr.charCodeAt(i);
        jsonStr = new TextDecoder().decode(bytes);
      } catch {
        return null;
      }
    } else {
      jsonStr = rawValue;
    }
    try {
      return JSON.parse(jsonStr);
    } catch {
      return null;
    }
  }

  function readChunkedFromJar(
    jar: Map<string, string>,
    key: string,
  ): string | null {
    const direct = jar.get(key);
    if (direct) return direct;
    const chunks: string[] = [];
    for (let i = 0; ; i++) {
      const chunk = jar.get(`${key}.${i}`);
      if (!chunk) break;
      chunks.push(chunk);
    }
    return chunks.length > 0 ? chunks.join("") : null;
  }

  it("unchunked → chunked: deletes old base cookie and sets new chunks", async () => {
    const oldCookieValue = encodeSessionCookie({
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_at: Math.floor(Date.now() / 1000) - 10,
    });

    const jar = new Map<string, string>();
    jar.set(TEST_COOKIE_NAME, oldCookieValue);

    simulateSuccessfulRefresh({
      access_token: "new-access-" + "x".repeat(6000),
      refresh_token: "new-refresh",
      expires_in: 3600,
    });

    const request = buildBrowserRequest("https://kzq.test/admin", jar);
    const result = await refreshSupabaseSession(request, NextResponse.next());

    applyResponseToBrowserJar(result, jar);

    // Old base cookie deleted, new chunks present
    expect(jar.has(TEST_COOKIE_NAME)).toBe(false);
    expect(jar.has(`${TEST_COOKIE_NAME}.0`)).toBe(true);

    const combined = readChunkedFromJar(jar, TEST_COOKIE_NAME);
    expect(combined).toBeTruthy();
    const session = decodeRawSession(combined!);
    expect(session).not.toBeNull();
    expect(session!.access_token).toContain("new-access");
  });

  it("3-chunk → 2-chunk: deletes stale higher chunks in the browser", async () => {
    // Build a session large enough to produce 3+ chunks
    const largeOldValue = encodeSessionCookie({
      access_token: "old-" + "x".repeat(9000),
      refresh_token: "old-refresh",
      expires_at: Math.floor(Date.now() / 1000) - 10,
    });

    const CHUNK_SIZE = 3180;
    const jar = new Map<string, string>();
    const encoded = encodeURIComponent(largeOldValue);
    let idx = 0;
    let remaining = encoded;
    while (remaining.length > 0) {
      let head = remaining.slice(0, CHUNK_SIZE);
      const lastEscape = head.lastIndexOf("%");
      if (lastEscape > CHUNK_SIZE - 3) head = head.slice(0, lastEscape);
      while (head.length > 0) {
        try { decodeURIComponent(head); break; } catch { head = head.slice(0, head.length - 3); }
      }
      jar.set(`${TEST_COOKIE_NAME}.${idx}`, decodeURIComponent(head));
      remaining = remaining.slice(head.length);
      idx++;
    }
    const oldChunkCount = idx;
    expect(oldChunkCount).toBeGreaterThanOrEqual(3);

    // New session: smaller, produces fewer chunks
    simulateSuccessfulRefresh({
      access_token: "new-" + "x".repeat(4000),
      refresh_token: "new-refresh",
      expires_in: 3600,
    });

    const request = buildBrowserRequest("https://kzq.test/admin", jar);
    const result = await refreshSupabaseSession(request, NextResponse.next());

    applyResponseToBrowserJar(result, jar);

    // Stale higher chunks must be deleted
    for (let i = 0; i < oldChunkCount; i++) {
      const chunkName = `${TEST_COOKIE_NAME}.${i}`;
      // All chunks that existed before but are no longer in the jar
      // must have been explicitly deleted (not just left behind)
      if (!jar.has(chunkName)) {
        // OK — either deleted or never set
      }
    }
    // Verify the highest old chunk is gone
    expect(jar.has(`${TEST_COOKIE_NAME}.${oldChunkCount - 1}`)).toBe(false);

    // The next request must read a valid NEW session
    const combined = readChunkedFromJar(jar, TEST_COOKIE_NAME);
    expect(combined).toBeTruthy();
    const session = decodeRawSession(combined!);
    expect(session).not.toBeNull();
    expect(session!.access_token).toContain("new-");
    expect(session!.refresh_token).toBe("new-refresh");
  });

  it("chunked → unchunked: deletes all old chunks", async () => {
    const largeOldValue = encodeSessionCookie({
      access_token: "old-" + "x".repeat(6000),
      refresh_token: "old-refresh",
      expires_at: Math.floor(Date.now() / 1000) - 10,
    });

    const CHUNK_SIZE = 3180;
    const jar = new Map<string, string>();
    const encoded = encodeURIComponent(largeOldValue);
    let idx = 0;
    let remaining = encoded;
    while (remaining.length > 0) {
      let head = remaining.slice(0, CHUNK_SIZE);
      const lastEscape = head.lastIndexOf("%");
      if (lastEscape > CHUNK_SIZE - 3) head = head.slice(0, lastEscape);
      while (head.length > 0) {
        try { decodeURIComponent(head); break; } catch { head = head.slice(0, head.length - 3); }
      }
      jar.set(`${TEST_COOKIE_NAME}.${idx}`, decodeURIComponent(head));
      remaining = remaining.slice(head.length);
      idx++;
    }
    const oldChunkCount = idx;
    expect(oldChunkCount).toBeGreaterThanOrEqual(2);

    simulateSuccessfulRefresh({
      access_token: "small-new",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });

    const request = buildBrowserRequest("https://kzq.test/admin", jar);
    const result = await refreshSupabaseSession(request, NextResponse.next());

    applyResponseToBrowserJar(result, jar);

    for (let i = 0; i < oldChunkCount; i++) {
      expect(jar.has(`${TEST_COOKIE_NAME}.${i}`)).toBe(false);
    }
    expect(jar.has(TEST_COOKIE_NAME)).toBe(true);

    const raw = jar.get(TEST_COOKIE_NAME)!;
    const session = decodeRawSession(raw);
    expect(session).not.toBeNull();
    expect(session!.access_token).toBe("small-new");
  });

  it("same chunk count replacement: no unnecessary delete directives", async () => {
    const oldValue = encodeSessionCookie({
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_at: Math.floor(Date.now() / 1000) - 10,
    });

    const jar = new Map<string, string>();
    jar.set(TEST_COOKIE_NAME, oldValue);

    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });

    const request = buildBrowserRequest("https://kzq.test/admin", jar);
    const result = await refreshSupabaseSession(request, NextResponse.next());

    const deleteCookies = result.cookies
      .getAll()
      .filter((c) => c.maxAge === 0);
    expect(deleteCookies.length).toBe(0);

    const setCookies = result.cookies
      .getAll()
      .filter((c) => c.maxAge !== 0);
    expect(setCookies.length).toBe(1);
    expect(setCookies[0].name).toBe(TEST_COOKIE_NAME);
  });
});

// ============================================================
// WP4: Refresh API request — no Authorization header
// ============================================================
describe("WP4: refresh API request — no old access token dependency", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", TEST_ANON_KEY);
  });

  it("does NOT send Authorization header (does not depend on old access token)", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });

    const pastExpiry = Math.floor(Date.now() / 1000) - 10;
    const cookieValue = encodeSessionCookie({
      access_token: "old-possibly-expired-access-token",
      refresh_token: "valid-refresh-token",
      expires_at: pastExpiry,
    });
    const request = new NextRequest("https://kzq.test/admin", {
      headers: { Cookie: `${TEST_COOKIE_NAME}=${cookieValue}` },
    });
    await refreshSupabaseSession(request, NextResponse.next());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers.Authorization).toBeUndefined();
    expect(JSON.stringify(options.headers)).not.toContain(
      "old-possibly-expired-access-token",
    );
    expect(options.headers.apikey).toBe(TEST_ANON_KEY);
    const body = JSON.parse(options.body);
    expect(body.refresh_token).toBe("valid-refresh-token");
  });
});
