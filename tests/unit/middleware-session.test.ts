import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ============================================================
// Supabase Auth Session Refresh — Middleware Tests
// ------------------------------------------------------------
// Verifies that:
//   1. shouldRefreshSession() only matches /admin, /api/admin, /api/internal
//      (and their subpaths) — NOT public ISR pages.
//   2. refreshSupabaseSession() is a no-op (returns original response
//      unchanged) when Supabase env vars are missing (Demo mode / local dev).
//   3. refreshSupabaseSession() calls supabase.auth.getUser() when env
//      vars are present.
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
//   7. A network failure during getUser() does NOT block the request
//      (fail-open for refresh; authorization is server-side). The
//      original response is returned.
//   8. The middleware applies security headers to ALL responses.
//   9. Public ISR paths do NOT trigger the session refresh (no Supabase
//      client is constructed).
// ============================================================

// --- Mocks ---------------------------------------------------------------
// We mock @supabase/ssr's createServerClient to:
//   - capture the cookies adapter (getAll/setAll) so tests can invoke
//     setAll() to simulate Supabase's auto-refresh behavior;
//   - return a stubbed auth.getUser() that tests can configure per-case.
//
// vi.mock is hoisted to the top of the file by the Vitest transformer,
// so any variables it closes over MUST be created via vi.hoisted() to
// avoid "Cannot access X before initialization" ReferenceErrors.
const hoisted = vi.hoisted(() => {
  // Mutable container — the hoisted mock writes the captured cookies
  // adapter here, and the test body reads it.
  const container = {
    mockGetUser: vi.fn(),
    createServerClientMock: vi.fn(),
    capturedCookiesAdapter: null as {
      getAll: () => Array<{ name: string; value: string }>;
      setAll: (
        cookies: Array<{ name: string; value: string; options?: unknown }>,
      ) => void;
    } | null,
  };
  return container;
});

vi.mock("@supabase/ssr", () => ({
  createServerClient: hoisted.createServerClientMock,
}));

const { mockGetUser, createServerClientMock } = hoisted;

import {
  refreshSupabaseSession,
  shouldRefreshSession,
  SESSION_REFRESH_PATHS,
} from "@/lib/supabase/middleware-session";

beforeEach(() => {
  hoisted.capturedCookiesAdapter = null;
  createServerClientMock.mockImplementation((_url, _key, config) => {
    hoisted.capturedCookiesAdapter = config.cookies;
    return {
      auth: {
        getUser: mockGetUser,
      },
    };
  });
  mockGetUser.mockReset();
  // Default: getUser resolves without rotating any cookie. Individual
  // tests opt into simulating a refresh via `simulateCookieRefresh()`.
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Configure mockGetUser to invoke the captured setAll() adapter with the
 * given cookies, simulating @supabase/ssr's auto-refresh behavior when
 * the access token is rotated.
 */
function simulateCookieRefresh(
  cookies: Array<{ name: string; value: string; options?: unknown }>,
) {
  mockGetUser.mockImplementationOnce(async () => {
    const adapter = hoisted.capturedCookiesAdapter;
    if (!adapter) {
      throw new Error("cookies adapter was not captured");
    }
    adapter.setAll(cookies);
    return { data: { user: null }, error: null };
  });
}

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
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(createServerClientMock).not.toHaveBeenCalled();
    // No Cache-Control mutation in Demo mode.
    expect(result.headers.get("Cache-Control")).toBeNull();
    // Security headers preserved.
    expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("returns the original response unchanged when NEXT_PUBLIC_SUPABASE_ANON_KEY is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const request = new NextRequest("https://kzq.test/admin");
    const response = NextResponse.next();
    const result = await refreshSupabaseSession(request, response);
    expect(result).toBe(response);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(createServerClientMock).not.toHaveBeenCalled();
  });
});

// ============================================================
// refreshSupabaseSession — no refresh occurred
// ============================================================
describe("refreshSupabaseSession — no cookie refresh", () => {
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

  it("returns the original response unchanged when no cookie was rotated", async () => {
    // Default mock: getUser resolves without calling setAll.
    const request = new NextRequest("https://kzq.test/admin");
    const response = NextResponse.next();
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("X-Frame-Options", "DENY");

    const result = await refreshSupabaseSession(request, response);

    // Same response object — no need to churn when nothing changed.
    expect(result).toBe(response);
    // No Cache-Control mutation when no auth cookie was refreshed.
    expect(result.headers.get("Cache-Control")).toBeNull();
    // Security headers preserved.
    expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(result.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("does NOT throw when getUser() fails (fail-open for refresh)", async () => {
    mockGetUser.mockRejectedValueOnce(new Error("network error"));
    const request = new NextRequest("https://kzq.test/admin");
    const response = NextResponse.next();
    response.headers.set("X-Content-Type-Options", "nosniff");
    // Must not throw — and must return the original response so the
    // caller's security headers survive the network failure.
    await expect(refreshSupabaseSession(request, response)).resolves.toBe(
      response,
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // No Cache-Control mutation on failure.
    expect(response.headers.get("Cache-Control")).toBeNull();
  });
});

// ============================================================
// refreshSupabaseSession — cookie refresh path
// ============================================================
describe("refreshSupabaseSession — cookie refresh", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
  });

  it("returns a NEW NextResponse (not the original) when cookies were refreshed", async () => {
    simulateCookieRefresh([
      {
        name: "sb-test-auth-token",
        value: "rotated-token-value",
        options: { httpOnly: true, path: "/" },
      },
    ]);
    const request = new NextRequest("https://kzq.test/admin");
    const original = NextResponse.next();
    const result = await refreshSupabaseSession(request, original);
    expect(result).not.toBe(original);
    expect(result).toBeInstanceOf(NextResponse);
  });

  it("writes Set-Cookie on the returned response with the rotated value", async () => {
    simulateCookieRefresh([
      {
        name: "sb-test-auth-token",
        value: "rotated-token-value",
        options: { httpOnly: true, path: "/" },
      },
    ]);
    const request = new NextRequest("https://kzq.test/admin");
    const original = NextResponse.next();
    const result = await refreshSupabaseSession(request, original);
    const setCookie = result.headers.get("Set-Cookie");
    expect(setCookie).toContain("sb-test-auth-token=rotated-token-value");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/");
  });

  it("forwards the rotated cookie to the downstream request (request.headers)", async () => {
    simulateCookieRefresh([
      {
        name: "sb-test-auth-token",
        value: "rotated-token-value",
        options: { httpOnly: true, path: "/" },
      },
    ]);
    const request = new NextRequest("https://kzq.test/admin");
    // Pre-condition: cookie is not present.
    expect(request.cookies.get("sb-test-auth-token")).toBeUndefined();
    await refreshSupabaseSession(request, NextResponse.next());
    // The downstream handler reading request.cookies should see the
    // rotated cookie — this is what makes the auto-refresh visible to
    // Server Components and Route Handlers.
    expect(request.cookies.get("sb-test-auth-token")?.value).toBe(
      "rotated-token-value",
    );
    // And it should be reflected in the Cookie header too.
    expect(request.headers.get("Cookie")).toContain(
      "sb-test-auth-token=rotated-token-value",
    );
  });

  it("sets Cache-Control: private, no-store on the returned response", async () => {
    simulateCookieRefresh([
      {
        name: "sb-test-auth-token",
        value: "rotated-token-value",
        options: {},
      },
    ]);
    const request = new NextRequest("https://kzq.test/admin");
    const original = NextResponse.next();
    const result = await refreshSupabaseSession(request, original);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("preserves all security headers from the original response", async () => {
    simulateCookieRefresh([
      { name: "sb-test-auth-token", value: "v", options: {} },
    ]);
    const request = new NextRequest("https://kzq.test/admin");
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
    simulateCookieRefresh([
      { name: "sb-test-auth-token", value: "rotated", options: {} },
    ]);
    const request = new NextRequest("https://kzq.test/admin");
    const original = NextResponse.next();
    // Caller-set cookie unrelated to Supabase auth — must survive the
    // response swap.
    original.cookies.set("caller-cookie", "caller-value", {
      httpOnly: true,
      path: "/",
    });

    const result = await refreshSupabaseSession(request, original);

    // The combined Set-Cookie header should contain BOTH the caller's
    // cookie and the refreshed auth cookie.
    const setCookieHeader = result.headers.get("Set-Cookie");
    expect(setCookieHeader).toContain("caller-cookie=caller-value");
    expect(setCookieHeader).toContain("sb-test-auth-token=rotated");
  });

  it("applies multiple rotated cookies when @supabase/ssr rotates access + refresh tokens", async () => {
    simulateCookieRefresh([
      {
        name: "sb-test-auth-token",
        value: "new-access",
        options: { httpOnly: true, path: "/" },
      },
      {
        name: "sb-test-refresh-token",
        value: "new-refresh",
        options: { httpOnly: true, path: "/" },
      },
    ]);
    const request = new NextRequest("https://kzq.test/admin");
    const original = NextResponse.next();
    const result = await refreshSupabaseSession(request, original);
    const setCookie = result.headers.get("Set-Cookie");
    expect(setCookie).toContain("sb-test-auth-token=new-access");
    expect(setCookie).toContain("sb-test-refresh-token=new-refresh");
    expect(request.cookies.get("sb-test-auth-token")?.value).toBe(
      "new-access",
    );
    expect(request.cookies.get("sb-test-refresh-token")?.value).toBe(
      "new-refresh",
    );
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

  it("does NOT construct a Supabase Session Client on public ISR paths", async () => {
    createServerClientMock.mockClear();
    const { middleware } = await import("@/middleware");
    const request = new NextRequest("https://kzq.test/products");
    await middleware(request);
    // Public ISR paths must not trigger session refresh — the Supabase
    // client must not be constructed at all.
    expect(createServerClientMock).not.toHaveBeenCalled();
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
    // No Cache-Control mutation on failure path.
    expect(response.headers.get("Cache-Control")).toBeNull();
  });

  it("returns a response with Cache-Control: private, no-store when cookies are refreshed via middleware", async () => {
    // Configure getUser to simulate a refresh.
    mockGetUser.mockImplementationOnce(async () => {
      const adapter = hoisted.capturedCookiesAdapter;
      if (!adapter) {
        throw new Error("cookies adapter was not captured");
      }
      adapter.setAll([
        {
          name: "sb-test-auth-token",
          value: "rotated-via-middleware",
          options: { httpOnly: true, path: "/" },
        },
      ]);
      return { data: { user: null }, error: null };
    });
    const { middleware } = await import("@/middleware");
    const request = new NextRequest("https://kzq.test/admin");
    const response = await middleware(request);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Set-Cookie")).toContain(
      "sb-test-auth-token=rotated-via-middleware",
    );
    // Security headers must survive the response swap.
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
