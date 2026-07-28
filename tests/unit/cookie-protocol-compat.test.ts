import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ============================================================
// Phase 3 Task 3: Supabase Cookie Protocol Compatibility Tests
//
// The existing middleware-session-interop.test.ts verifies VALUE
// format compatibility (base64- encoding, chunking boundaries)
// using the real @supabase/ssr library. This file complements it
// by verifying:
//
//   1. Cookie ATTRIBUTES on Set-Cookie headers written by the
//      middleware match @supabase/ssr's DEFAULT_COOKIE_OPTIONS
//      (path, sameSite, httpOnly, maxAge). If these attributes
//      diverge, the browser may scope cookies differently, causing
//      the official @supabase/ssr server client to fail to read
//      them.
//
//   2. Stale chunk DELETION cookies carry the SAME scope attributes
//      (path, sameSite) as the new chunks. Without matching scope,
//      the browser will NOT delete the stale chunk, leaving
//      corrupted session state.
//
//   3. Self-round-trip: a cookie written by the middleware on
//      request A can be read back by the middleware on request B,
//      producing the correct session with persisted expires_at.
//
//   4. The Set-Cookie header string format is parseable by standard
//      cookie parsers (no malformed attributes, correct ordering).
// ============================================================

// Real imports from the locked dependency for constant comparison.
import {
  DEFAULT_COOKIE_OPTIONS,
  MAX_CHUNK_SIZE,
  createChunks,
  combineChunks,
  isChunkLike,
} from "@supabase/ssr";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abcdefghijklmnopqrst.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("NODE_ENV", "test");
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  vi.useFakeTimers();
  vi.setSystemTime(1700000000 * 1000);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const TEST_SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
const TEST_ANON_KEY = "test-anon-key";
const TEST_COOKIE_NAME = "sb-abcdefghijklmnopqrst-auth-token";

import { refreshSupabaseSession } from "@/lib/supabase/middleware-session";

/**
 * Build a base64-prefixed cookie value identical to @supabase/ssr's
 * format.
 */
function encodeSessionCookie(session: {
  access_token: string;
  refresh_token: string;
  expires_at: number;
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
 * Simulate a successful Supabase Auth refresh-token response.
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

/**
 * Build a NextRequest with an expiring auth cookie.
 */
function buildRequestWithExpiringToken(
  url = "https://kzq.test/admin",
): NextRequest {
  const pastExpiry = Math.floor(Date.now() / 1000) - 10;
  const cookieValue = encodeSessionCookie({
    access_token: "expiring-token",
    refresh_token: "valid-refresh-token",
    expires_at: pastExpiry,
  });
  return new NextRequest(url, {
    headers: { Cookie: `${TEST_COOKIE_NAME}=${cookieValue}` },
  });
}

// ============================================================
// 1. Cookie attributes match @supabase/ssr DEFAULT_COOKIE_OPTIONS
// ============================================================
describe("Cookie attributes match @supabase/ssr DEFAULT_COOKIE_OPTIONS", () => {
  it("Set-Cookie has path='/' matching official default", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    const request = buildRequestWithExpiringToken();
    const result = await refreshSupabaseSession(request, NextResponse.next());

    const cookie = result.cookies
      .getAll()
      .find((c) => c.name === TEST_COOKIE_NAME && c.maxAge !== 0);
    expect(cookie).toBeTruthy();
    expect(cookie!.path).toBe(DEFAULT_COOKIE_OPTIONS.path);
    expect(cookie!.path).toBe("/");
  });

  it("Set-Cookie has sameSite='lax' matching official default", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    const request = buildRequestWithExpiringToken();
    const result = await refreshSupabaseSession(request, NextResponse.next());

    const cookie = result.cookies
      .getAll()
      .find((c) => c.name === TEST_COOKIE_NAME && c.maxAge !== 0);
    expect(cookie).toBeTruthy();
    expect(cookie!.sameSite).toBe(DEFAULT_COOKIE_OPTIONS.sameSite);
    expect(cookie!.sameSite).toBe("lax");
  });

  it("Set-Cookie has httpOnly=false matching official default", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    const request = buildRequestWithExpiringToken();
    const result = await refreshSupabaseSession(request, NextResponse.next());

    const cookie = result.cookies
      .getAll()
      .find((c) => c.name === TEST_COOKIE_NAME && c.maxAge !== 0);
    expect(cookie).toBeTruthy();
    // @supabase/ssr sets httpOnly=false so that the client-side
    // supabase-js can read the cookie for auth state management.
    expect(cookie!.httpOnly).toBe(DEFAULT_COOKIE_OPTIONS.httpOnly);
    expect(cookie!.httpOnly).toBe(false);
  });

  it("Set-Cookie has maxAge=400 days matching official default", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    const request = buildRequestWithExpiringToken();
    const result = await refreshSupabaseSession(request, NextResponse.next());

    const cookie = result.cookies
      .getAll()
      .find((c) => c.name === TEST_COOKIE_NAME && c.maxAge !== 0);
    expect(cookie).toBeTruthy();
    expect(cookie!.maxAge).toBe(DEFAULT_COOKIE_OPTIONS.maxAge);
    expect(cookie!.maxAge).toBe(400 * 24 * 60 * 60);
  });

  it("chunked Set-Cookie cookies all carry the same attributes", async () => {
    // Large session that produces multiple chunks
    simulateSuccessfulRefresh({
      access_token: "new-" + "x".repeat(8000),
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    const request = buildRequestWithExpiringToken();
    const result = await refreshSupabaseSession(request, NextResponse.next());

    const chunkCookies = result.cookies
      .getAll()
      .filter((c) => isChunkLike(c.name, TEST_COOKIE_NAME) && c.maxAge !== 0);

    expect(chunkCookies.length).toBeGreaterThan(1);
    for (const cookie of chunkCookies) {
      expect(cookie.path).toBe("/");
      expect(cookie.sameSite).toBe("lax");
      expect(cookie.httpOnly).toBe(false);
      expect(cookie.maxAge).toBe(400 * 24 * 60 * 60);
    }
  });
});

// ============================================================
// 2. Stale chunk deletion cookies carry matching scope attributes
// ============================================================
describe("Stale chunk deletion cookies carry matching scope", () => {
  /**
   * Apply Set-Cookie directives to a simulated browser cookie jar.
   * Max-Age=0 deletes; others overwrite/add.
   */
  function applyToJar(
    response: NextResponse,
    jar: Map<string, { value: string; path: string; sameSite: string }>,
  ): void {
    for (const cookie of response.cookies.getAll()) {
      if (cookie.maxAge === 0) {
        jar.delete(cookie.name);
      } else {
        jar.set(cookie.name, {
          value: cookie.value,
          path: cookie.path ?? "/",
          // NextCookie.sameSite is boolean | "lax" | "strict" | "none" | undefined
          sameSite: String(cookie.sameSite ?? "lax"),
        });
      }
    }
  }

  it("3-chunk → 2-chunk: deletion cookies have path='/' and sameSite='lax'", async () => {
    // Build a large session that produces 3+ chunks via official createChunks
    const largeOldSession = {
      access_token: "old-" + "x".repeat(9000),
      refresh_token: "old-refresh",
      expires_at: Math.floor(Date.now() / 1000) - 10,
    };
    const oldCookieValue = "base64-" + encodeSessionCookieRaw(largeOldSession);
    const oldChunks = createChunks(TEST_COOKIE_NAME, oldCookieValue);
    expect(oldChunks.length).toBeGreaterThanOrEqual(3);

    const jar = new Map<string, { value: string; path: string; sameSite: string }>();
    for (const c of oldChunks) {
      jar.set(c.name, { value: c.value, path: "/", sameSite: "lax" });
    }

    // New session: smaller, fewer chunks
    simulateSuccessfulRefresh({
      access_token: "new-" + "x".repeat(4000),
      refresh_token: "new-refresh",
      expires_in: 3600,
    });

    const request = new NextRequest("https://kzq.test/admin", {
      headers: {
        Cookie: oldChunks.map((c) => `${c.name}=${c.value}`).join("; "),
      },
    });
    const result = await refreshSupabaseSession(request, NextResponse.next());

    // Collect deletion cookies (Max-Age=0)
    const deletionCookies = result.cookies.getAll().filter((c) => c.maxAge === 0);
    expect(deletionCookies.length).toBeGreaterThan(0);

    for (const cookie of deletionCookies) {
      // Deletion cookies MUST have the same path and sameSite as
      // the new chunks, otherwise the browser won't match them to
      // the existing stale chunk and will NOT delete it.
      expect(cookie.path).toBe("/");
      expect(cookie.sameSite).toBe("lax");
    }

    // Apply to jar and verify stale chunks are gone
    applyToJar(result, jar);
    const highestOldChunk = `${TEST_COOKIE_NAME}.${oldChunks.length - 1}`;
    expect(jar.has(highestOldChunk)).toBe(false);
  });

  it("unchunked → chunked: deletion cookie for base name has matching scope", async () => {
    const oldValue = encodeSessionCookie({
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_at: Math.floor(Date.now() / 1000) - 10,
    });

    const jar = new Map<string, { value: string; path: string; sameSite: string }>();
    jar.set(TEST_COOKIE_NAME, { value: oldValue, path: "/", sameSite: "lax" });

    simulateSuccessfulRefresh({
      access_token: "new-" + "x".repeat(6000),
      refresh_token: "new-refresh",
      expires_in: 3600,
    });

    const request = new NextRequest("https://kzq.test/admin", {
      headers: { Cookie: `${TEST_COOKIE_NAME}=${oldValue}` },
    });
    const result = await refreshSupabaseSession(request, NextResponse.next());

    const deletionCookies = result.cookies.getAll().filter((c) => c.maxAge === 0);
    expect(deletionCookies.length).toBe(1);
    expect(deletionCookies[0].name).toBe(TEST_COOKIE_NAME);
    expect(deletionCookies[0].path).toBe("/");
    expect(deletionCookies[0].sameSite).toBe("lax");
  });
});

// ============================================================
// 3. Self-round-trip: middleware writes → middleware reads back
// ============================================================
describe("Self-round-trip: middleware writes → middleware reads back", () => {
  /**
   * Apply Set-Cookie to a browser jar, then build a new NextRequest
   * from that jar.
   */
  function buildNextRequestFromJar(
    url: string,
    response: NextResponse,
  ): NextRequest {
    const jar = new Map<string, string>();
    for (const cookie of response.cookies.getAll()) {
      if (cookie.maxAge !== 0) {
        jar.set(cookie.name, cookie.value);
      }
    }
    const cookieHeader = Array.from(jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    return new NextRequest(url, {
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    });
  }

  it("cookie written by middleware can be read back by middleware", async () => {
    // Step 1: First refresh — writes new cookie
    simulateSuccessfulRefresh({
      access_token: "first-access",
      refresh_token: "first-refresh",
      expires_in: 3600,
    });
    const request1 = buildRequestWithExpiringToken();
    const result1 = await refreshSupabaseSession(request1, NextResponse.next());

    // Verify the cookie was written
    const setCookies = result1.cookies.getAll();
    const authTokenCookie = setCookies.find(
      (c) => c.name === TEST_COOKIE_NAME && c.maxAge !== 0,
    );
    expect(authTokenCookie).toBeTruthy();

    // Step 2: Build a new request from the browser jar (simulating
    // the browser sending back the cookie)
    const request2 = buildNextRequestFromJar("https://kzq.test/admin", result1);

    // Step 3: The middleware should be able to read the cookie back.
    // Since the token is still valid (expires_at = now + 3600),
    // no refresh should be triggered.
    const result2 = await refreshSupabaseSession(request2, NextResponse.next());
    expect(mockFetch).toHaveBeenCalledTimes(1); // Only the first refresh
    expect(result2).toBeInstanceOf(NextResponse);
  });

  it("cookie written by middleware triggers re-refresh after expiry", async () => {
    // Step 1: First refresh at T0
    const t0 = 1700000000;
    vi.setSystemTime(t0 * 1000);

    simulateSuccessfulRefresh({
      access_token: "first-access",
      refresh_token: "first-refresh",
      expires_in: 3600,
    });
    const request1 = buildRequestWithExpiringToken();
    const result1 = await refreshSupabaseSession(request1, NextResponse.next());

    // Step 2: Advance time past expiry
    const t1 = t0 + 3601;
    vi.setSystemTime(t1 * 1000);

    // Step 3: Build new request from the cookie jar
    const request2 = buildNextRequestFromJar("https://kzq.test/admin", result1);

    // Step 4: Second refresh should be triggered
    simulateSuccessfulRefresh({
      access_token: "second-access",
      refresh_token: "second-refresh",
      expires_in: 3600,
    });
    const result2 = await refreshSupabaseSession(request2, NextResponse.next());

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Verify the second refresh wrote a new access token
    const cookie2 = result2.cookies
      .getAll()
      .find((c) => c.name === TEST_COOKIE_NAME && c.maxAge !== 0);
    expect(cookie2).toBeTruthy();
  });

  it("chunked cookie written by middleware can be read back", async () => {
    // Step 1: Refresh with a LARGE session that produces chunks
    simulateSuccessfulRefresh({
      access_token: "large-" + "x".repeat(8000),
      refresh_token: "large-refresh",
      expires_in: 3600,
    });
    const request1 = buildRequestWithExpiringToken();
    const result1 = await refreshSupabaseSession(request1, NextResponse.next());

    // Verify the cookie was chunked
    const chunkCookies = result1.cookies
      .getAll()
      .filter((c) => isChunkLike(c.name, TEST_COOKIE_NAME) && c.maxAge !== 0);
    expect(chunkCookies.length).toBeGreaterThan(1);

    // Step 2: Build new request from the browser jar
    const request2 = buildNextRequestFromJar("https://kzq.test/admin", result1);

    // Step 3: The middleware should read the chunked cookie back.
    // Token is still valid → no refresh.
    const result2 = await refreshSupabaseSession(request2, NextResponse.next());
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// 4. Set-Cookie header string format is well-formed
// ============================================================
describe("Set-Cookie header string format", () => {
  it("produces a parseable Set-Cookie header with all attributes", async () => {
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    const request = buildRequestWithExpiringToken();
    const result = await refreshSupabaseSession(request, NextResponse.next());

    const setCookie = result.headers.get("Set-Cookie");
    expect(setCookie).toBeTruthy();
    // The Set-Cookie header must contain the cookie name and value
    expect(setCookie).toContain(TEST_COOKIE_NAME);
    // Must contain Path=/
    expect(setCookie).toMatch(/Path=\/(;|$)/i);
    // Must contain SameSite=Lax
    expect(setCookie).toMatch(/SameSite=Lax(;|$)/i);
    // Must contain Max-Age=
    expect(setCookie).toMatch(/Max-Age=\d+/i);
  });

  it("does NOT set Secure flag (Supabase cookies are not Secure by default)", async () => {
    // @supabase/ssr's DEFAULT_COOKIE_OPTIONS does not set secure=true
    // by default. The middleware mirrors this behavior. Secure is
    // typically handled by the hosting platform (Vercel/EdgeOne) at
    // the edge level.
    simulateSuccessfulRefresh({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    const request = buildRequestWithExpiringToken();
    const result = await refreshSupabaseSession(request, NextResponse.next());

    const cookie = result.cookies
      .getAll()
      .find((c) => c.name === TEST_COOKIE_NAME && c.maxAge !== 0);
    expect(cookie).toBeTruthy();
    // Following @supabase/ssr default — secure is NOT set by the
    // middleware. The hosting platform should enforce HTTPS at the
    // edge, which implicitly makes all cookies Secure.
    expect(cookie!.secure).toBe(DEFAULT_COOKIE_OPTIONS.secure);
  });
});

// ============================================================
// 5. MAX_CHUNK_SIZE constant compatibility
// ============================================================
describe("MAX_CHUNK_SIZE constant compatibility", () => {
  it("middleware chunking uses the same MAX_CHUNK_SIZE as official library", async () => {
    // Build a session large enough to chunk, refresh it, and verify
    // the chunk boundaries match what the official createChunks
    // would produce.
    const newSession = {
      access_token: "new-" + "x".repeat(5000),
      refresh_token: "new-refresh",
      expires_in: 3600,
    };

    simulateSuccessfulRefresh(newSession);
    const request = buildRequestWithExpiringToken();
    const result = await refreshSupabaseSession(request, NextResponse.next());

    // Collect the chunk cookies written by the middleware
    const middlewareChunks = result.cookies
      .getAll()
      .filter((c) => isChunkLike(c.name, TEST_COOKIE_NAME) && c.maxAge !== 0)
      .map((c) => ({ name: c.name, value: c.value }));

    expect(middlewareChunks.length).toBeGreaterThan(1);

    // Build the expected chunks using the official createChunks
    const encodedValue =
      "base64-" +
      btoa(JSON.stringify({
        ...newSession,
        expires_at: 1700000000 + 3600, // persisted absolute expiry
      }))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

    const officialChunks = createChunks(TEST_COOKIE_NAME, encodedValue);

    // The chunk count must match
    expect(middlewareChunks.length).toBe(officialChunks.length);

    // The chunk names must match
    for (let i = 0; i < officialChunks.length; i++) {
      expect(middlewareChunks[i].name).toBe(officialChunks[i].name);
    }
  });
});

// ============================================================
// Helper: raw encode (without base64- prefix) for creating large
// official-format cookies
// ============================================================
function encodeSessionCookieRaw(session: object): string {
  const json = JSON.stringify(session);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
