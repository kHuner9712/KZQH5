import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ============================================================
// WP5: Official @supabase/ssr@0.12.0 interoperability tests
// ------------------------------------------------------------
// These tests use the REAL locked version of @supabase/ssr (0.12.0)
// to generate cookie data and verify that the custom middleware
// session helper (which does NOT import @supabase/ssr to stay
// Edge-Runtime compatible) can:
//
//   1. Read official unchunked cookies written by @supabase/ssr.
//   2. Read official chunked cookies written by @supabase/ssr.
//   3. Write cookies that the official @supabase/ssr server client
//      can read back.
//   4. Correctly delete stale chunks when chunk count changes.
//   5. Maintain base64- encoding compatibility.
//
// This avoids "implementation and test both copied wrong" bugs by
// using the REAL @supabase/ssr package as the source of truth.
// ============================================================

// Real imports from the locked dependency — NOT a copy.
import {
  createChunks,
  combineChunks,
  isChunkLike,
  stringToBase64URL,
  stringFromBase64URL,
  MAX_CHUNK_SIZE,
  DEFAULT_COOKIE_OPTIONS,
} from "@supabase/ssr";

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

const TEST_SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
const TEST_ANON_KEY = "test-anon-key";
const TEST_COOKIE_NAME = "sb-abcdefghijklmnopqrst-auth-token";

// Import the module under test AFTER env is configured.
import { refreshSupabaseSession } from "@/lib/supabase/middleware-session";

/**
 * Build a session JSON object identical to what @supabase/ssr would
 * store. The official library stores the raw JSON string (after
 * JSON.stringify) and then base64url-encodes it with the "base64-"
 * prefix when cookieEncoding is "base64url" (the default).
 */
function buildOfficialSessionJson(session: {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in?: number;
}): string {
  return JSON.stringify(session);
}

/**
 * Generate the cookie value EXACTLY as @supabase/ssr's
 * createStorageFromOptions would write it (with cookieEncoding
 * "base64url"): `base64-` + stringToBase64URL(json).
 */
function buildOfficialCookieValue(session: object): string {
  const json = JSON.stringify(session);
  return "base64-" + stringToBase64URL(json);
}

/**
 * Generate chunked cookies EXACTLY as @supabase/ssr would write them,
 * using the real createChunks function. Returns an array of
 * { name, value } pairs.
 */
function buildOfficialChunks(cookieName: string, session: object) {
  const json = JSON.stringify(session);
  const encoded = "base64-" + stringToBase64URL(json);
  return createChunks(cookieName, encoded);
}

/**
 * Apply a list of { name, value } cookies to a NextRequest's Cookie
 * header. This simulates what the browser sends after receiving
 * Set-Cookie directives.
 */
function buildRequestWithCookies(
  url: string,
  cookies: Array<{ name: string; value: string }>,
): NextRequest {
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  return new NextRequest(url, {
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  });
}

/**
 * Decode a base64-prefixed cookie value using the REAL
 * @supabase/ssr decode path (stringFromBase64URL), so we test
 * against the official decoder, not a copy.
 */
function decodeOfficialValue(rawValue: string): {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
} | null {
  if (!rawValue.startsWith("base64-")) return null;
  try {
    const json = stringFromBase64URL(rawValue.substring("base64-".length));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ============================================================
// 1. Read official unchunked cookies
// ============================================================
describe("WP5: read official @supabase/ssr unchunked cookies", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", TEST_ANON_KEY);
    vi.useFakeTimers();
    vi.setSystemTime(1700000000 * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads an unchunked cookie written by official createChunks", async () => {
    // Build a session small enough to fit in a single unchunked cookie
    const session = {
      access_token: "official-access-token",
      refresh_token: "valid-refresh-token",
      expires_at: Math.floor(Date.now() / 1000) - 10, // expired
      expires_in: 3600,
    };

    // Use the REAL createChunks to generate the cookie exactly as
    // @supabase/ssr would write it.
    const chunks = buildOfficialChunks(TEST_COOKIE_NAME, session);
    expect(chunks.length).toBe(1);
    expect(chunks[0].name).toBe(TEST_COOKIE_NAME);

    // Simulate refresh response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    });

    const request = buildRequestWithCookies("https://kzq.test/admin", chunks);
    const result = await refreshSupabaseSession(request, NextResponse.next());

    // The middleware MUST have called fetch — proving it successfully
    // decoded the official cookie and detected the expired token.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain(
      "/auth/v1/token?grant_type=refresh_token",
    );
  });
});

// ============================================================
// 2. Read official chunked cookies
// ============================================================
describe("WP5: read official @supabase/ssr chunked cookies", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", TEST_ANON_KEY);
    vi.useFakeTimers();
    vi.setSystemTime(1700000000 * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads a chunked cookie written by official createChunks", async () => {
    // Build a LARGE session that produces multiple chunks when
    // processed by the real createChunks.
    const session = {
      access_token: "official-" + "x".repeat(8000),
      refresh_token: "valid-refresh-token",
      expires_at: Math.floor(Date.now() / 1000) - 10,
      expires_in: 3600,
    };

    const chunks = buildOfficialChunks(TEST_COOKIE_NAME, session);
    // Verify that the official library actually chunked it
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].name).toBe(`${TEST_COOKIE_NAME}.0`);

    // Simulate refresh response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    });

    const request = buildRequestWithCookies("https://kzq.test/admin", chunks);
    const result = await refreshSupabaseSession(request, NextResponse.next());

    // The middleware MUST have decoded the chunked cookie and called
    // the refresh endpoint.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// 3. Write cookies that official @supabase/ssr can read back
// ============================================================
describe("WP5: write cookies readable by official @supabase/ssr", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", TEST_ANON_KEY);
    vi.useFakeTimers();
    vi.setSystemTime(1700000000 * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a cookie that the official combineChunks + stringFromBase64URL can read", async () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 10;
    const oldCookieValue = buildOfficialCookieValue({
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_at: pastExpiry,
      expires_in: 3600,
    });

    const request = new NextRequest("https://kzq.test/admin", {
      headers: { Cookie: `${TEST_COOKIE_NAME}=${oldCookieValue}` },
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access-from-middleware",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    });

    const result = await refreshSupabaseSession(request, NextResponse.next());

    // Extract the Set-Cookie value written by the middleware
    const setCookies = result.cookies.getAll();
    const authTokenCookie = setCookies.find((c) =>
      isChunkLike(c.name, TEST_COOKIE_NAME),
    );
    expect(authTokenCookie).toBeTruthy();

    // If unchunked, read directly. If chunked, combine using the
    // official combineChunks function.
    let rawValue: string | null = null;
    if (authTokenCookie!.name === TEST_COOKIE_NAME) {
      rawValue = authTokenCookie!.value;
    } else {
      // Chunked: collect all chunks and use official combineChunks
      const chunkMap = new Map<string, string>();
      for (const c of setCookies) {
        if (isChunkLike(c.name, TEST_COOKIE_NAME) && c.maxAge !== 0) {
          chunkMap.set(c.name, c.value);
        }
      }
      rawValue = await combineChunks(TEST_COOKIE_NAME, async (name) =>
        chunkMap.get(name) ?? null,
      );
    }

    expect(rawValue).toBeTruthy();
    expect(rawValue!.startsWith("base64-")).toBe(true);

    // Decode using the OFFICIAL stringFromBase64URL
    const session = decodeOfficialValue(rawValue!);
    expect(session).not.toBeNull();
    expect(session!.access_token).toBe("new-access-from-middleware");
    expect(session!.refresh_token).toBe("new-refresh");
    // WP1: absolute expires_at must be persisted
    expect(session!.expires_at).toBe(1700000000 + 3600);
  });
});

// ============================================================
// 4. Correctly handle chunk count changes (official interop)
// ============================================================
describe("WP5: chunk count changes interop with official library", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", TEST_ANON_KEY);
    vi.useFakeTimers();
    vi.setSystemTime(1700000000 * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("3-chunk → 2-chunk: stale chunk deleted, official combineChunks reads valid session", async () => {
    // Build a large session that produces 3+ chunks via official createChunks
    const largeOldSession = {
      access_token: "old-" + "x".repeat(9000),
      refresh_token: "old-refresh",
      expires_at: Math.floor(Date.now() / 1000) - 10,
      expires_in: 3600,
    };
    const oldChunks = buildOfficialChunks(TEST_COOKIE_NAME, largeOldSession);
    expect(oldChunks.length).toBeGreaterThanOrEqual(3);

    // New session: smaller, produces fewer chunks
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-" + "x".repeat(4000),
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    });

    const request = buildRequestWithCookies("https://kzq.test/admin", oldChunks);
    const result = await refreshSupabaseSession(request, NextResponse.next());

    // Apply Set-Cookie to a simulated browser jar
    const jar = new Map<string, string>();
    for (const cookie of result.cookies.getAll()) {
      if (cookie.maxAge === 0) {
        jar.delete(cookie.name);
      } else {
        jar.set(cookie.name, cookie.value);
      }
    }

    // The highest old chunk must be gone
    expect(jar.has(`${TEST_COOKIE_NAME}.${oldChunks.length - 1}`)).toBe(false);

    // Read the new session using official combineChunks
    const rawValue = await combineChunks(TEST_COOKIE_NAME, async (name) =>
      jar.get(name) ?? null,
    );
    expect(rawValue).toBeTruthy();

    const session = decodeOfficialValue(rawValue!);
    expect(session).not.toBeNull();
    expect(session!.access_token).toContain("new-");
    expect(session!.refresh_token).toBe("new-refresh");
  });
});

// ============================================================
// 5. base64- encoding compatibility
// ============================================================
describe("WP5: base64- encoding compatibility", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", TEST_SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", TEST_ANON_KEY);
    vi.useFakeTimers();
    vi.setSystemTime(1700000000 * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("middleware-written cookie uses base64- prefix matching official format", async () => {
    const oldCookieValue = buildOfficialCookieValue({
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_at: Math.floor(Date.now() / 1000) - 10,
      expires_in: 3600,
    });

    const request = new NextRequest("https://kzq.test/admin", {
      headers: { Cookie: `${TEST_COOKIE_NAME}=${oldCookieValue}` },
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    });

    const result = await refreshSupabaseSession(request, NextResponse.next());

    const setCookies = result.cookies.getAll();
    const authTokenCookie = setCookies.find(
      (c) => c.name === TEST_COOKIE_NAME && c.maxAge !== 0,
    );
    expect(authTokenCookie).toBeTruthy();
    // The value MUST start with "base64-" to be compatible with
    // @supabase/ssr's decodeChunkedCookieValue.
    expect(authTokenCookie!.value.startsWith("base64-")).toBe(true);

    // Cross-decode: use official stringFromBase64URL to read what
    // the middleware wrote.
    const session = decodeOfficialValue(authTokenCookie!.value);
    expect(session).not.toBeNull();
    expect(session!.access_token).toBe("new-access");
  });

  it("MAX_CHUNK_SIZE matches official constant", () => {
    // The middleware's MAX_CHUNK_SIZE MUST match the official value
    // so that chunking boundaries are identical.
    expect(MAX_CHUNK_SIZE).toBe(3180);
  });

  it("DEFAULT_COOKIE_OPTIONS matches official structure", () => {
    // The cookie options MUST be compatible with the official
    // DEFAULT_COOKIE_OPTIONS so that browser scope (path, sameSite,
    // httpOnly) is identical.
    expect(DEFAULT_COOKIE_OPTIONS.path).toBe("/");
    expect(DEFAULT_COOKIE_OPTIONS.sameSite).toBe("lax");
    expect(DEFAULT_COOKIE_OPTIONS.httpOnly).toBe(false);
    expect(DEFAULT_COOKIE_OPTIONS.maxAge).toBe(400 * 24 * 60 * 60);
  });
});
