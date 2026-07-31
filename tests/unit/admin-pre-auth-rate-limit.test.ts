import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ============================================================
// KZQ-P1-010: Pre-auth coarse rate limiting for admin endpoints
// ------------------------------------------------------------
// requireAdminWrite() and requireAdminRead() historically called
// getVerifiedAdmin() (which performs a REMOTE auth.getUser() call +
// DB profile query) BEFORE any rate limiting. This meant an
// unauthenticated attacker could send unlimited requests to
// /api/admin/* endpoints, each triggering expensive remote Supabase
// Auth calls, without consuming any rate-limit quota.
//
// The fix adds a pre-auth rate-limit check BEFORE getVerifiedAdmin()
// using the two-layer ephemeralRateKeySet model (trusted IP → per-IP
// bucket; no trusted IP → fallback:global floor + optional HMAC).
//
// These tests verify:
//   1. Pre-auth rate limit blocks unauthenticated requests before
//      getVerifiedAdmin() is called.
//   2. Pre-auth rate limit allows legitimate requests under threshold.
//   3. Pre-auth rate limit uses IP from trusted proxy header (per-IP).
//   4. Pre-auth rate limit does NOT trust x-forwarded-for.
//   5. Both requireAdminWrite and requireAdminRead enforce pre-auth limit.
//   6. getAdminPreAuthRateLimiter factory returns a singleton limiter.
//
// Each test uses a unique IP address to avoid interference between
// tests (the limiter singleton persists across tests, but each IP
// gets its own bucket).
// ============================================================

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: vi.fn(),
}));

import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  requireAdminWrite,
  requireAdminRead,
} from "@/lib/services/admin-write-boundary";
import { getAdminPreAuthRateLimiter } from "@/lib/services/rate-limit";

// Test fixtures: no real email, UUID, token, or database error text.
const mockUser = { id: "test-user-id", email: null } as any;
const mockProfile = {
  id: "test-user-id",
  email: null,
  role: "admin",
} as any;

function makeSessionClient(opts: {
  user?: any;
  error?: any;
}) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: opts.user ?? null },
        error: opts.error ?? null,
      }),
    },
  };
}

function makeAdminClient(opts: { profile?: any; error?: any }) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: opts.profile ?? null,
            error: opts.error ?? null,
          }),
        }),
      }),
    }),
  };
}

/**
 * Build a NextRequest with the given headers and method.
 */
function makeRequest(
  path: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): NextRequest {
  const method = opts.method ?? "POST";
  const url = `https://kzq.test${path}`;
  const headers = new Headers(opts.headers);
  // NextRequest constructor in the test environment does NOT auto-set the
  // Host header from the URL (unlike real HTTP). isSameOrigin() reads
  // x-forwarded-host || host, so we must set it explicitly.
  if (!headers.has("host")) {
    headers.set("host", "kzq.test");
  }
  if (opts.body !== undefined && method !== "GET" && method !== "HEAD") {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    headers.set("content-length", String(JSON.stringify(opts.body).length));
  }
  // Origin + Sec-Fetch-Site must be same-origin for write endpoints.
  if (!headers.has("origin")) {
    headers.set("origin", "https://kzq.test");
  }
  if (!headers.has("sec-fetch-site")) {
    headers.set("sec-fetch-site", "same-origin");
  }
  const body =
    opts.body !== undefined && method !== "GET" && method !== "HEAD"
      ? JSON.stringify(opts.body)
      : undefined;
  return new NextRequest(url, { method, headers, body });
}

/**
 * Unique IP counter to ensure each test gets a fresh IP bucket.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  // Use 198.51.100.0/24 range (TEST-NET-2) to avoid collisions.
  return `198.51.100.${ipCounter % 256}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("TRUSTED_PROXY_HEADER", "x-edgeone-client-ip");
  vi.stubEnv("NODE_ENV", "production");

  // Set up default mock implementations for successful auth.
  vi.mocked(createServerSupabaseClient).mockReturnValue(
    makeSessionClient({ user: mockUser }) as any,
  );
  vi.mocked(createAdminSupabaseClient).mockReturnValue(
    makeAdminClient({ profile: mockProfile }) as any,
  );
});

describe("KZQ-P1-010: Pre-auth rate limiting — requireAdminWrite", () => {
  it("1. calls getVerifiedAdmin() when pre-auth limit is NOT exceeded", async () => {
    const ip = uniqueIp();
    const req = makeRequest("/api/admin/products", {
      method: "POST",
      headers: { "x-edgeone-client-ip": ip },
      body: { name: "test" },
    });

    const result = await requireAdminWrite(req, { maxBytes: 1024 * 1024 });
    expect(result.ok).toBe(true);
    // getVerifiedAdmin was called (createServerSupabaseClient was invoked).
    expect(createServerSupabaseClient).toHaveBeenCalled();
  });

  it("2. returns 429 WITHOUT calling getVerifiedAdmin() when pre-auth limit exceeded", async () => {
    const ip = uniqueIp();

    // Exhaust the pre-auth limiter (30 req / 60s) from a single IP.
    // Mock returns NO session (unauthenticated) for the exhausting requests.
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      makeSessionClient({ user: null }) as any,
    );

    for (let i = 0; i < 30; i++) {
      const req = makeRequest("/api/admin/products", {
        method: "POST",
        headers: { "x-edgeone-client-ip": ip },
        body: { name: "test" },
      });
      await requireAdminWrite(req, { maxBytes: 1024 * 1024 });
    }

    // Now set up mock for a SUCCESSFUL auth session, then verify the
    // 31st request is STILL blocked at pre-auth (getVerifiedAdmin
    // is NOT called).
    vi.mocked(createServerSupabaseClient).mockClear();
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      makeSessionClient({ user: mockUser }) as any,
    );

    const req31 = makeRequest("/api/admin/products", {
      method: "POST",
      headers: { "x-edgeone-client-ip": ip },
      body: { name: "test" },
    });
    const result = await requireAdminWrite(req31, { maxBytes: 1024 * 1024 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(429);
      const body = await result.response.json();
      expect(body.error).toBe("ADMIN_WRITE_RATE_LIMITED");
      expect(result.response.headers.get("Retry-After")).toBeTruthy();
      expect(result.response.headers.get("Cache-Control")).toContain(
        "no-store",
      );
    }

    // CRITICAL: getVerifiedAdmin() was NOT called — createServerSupabaseClient
    // (which is the first step of getVerifiedAdmin) was not invoked.
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });

  it("3. pre-auth limit is per-IP (different IPs have separate buckets)", async () => {
    const ip1 = uniqueIp();
    const ip2 = uniqueIp();

    // Exhaust the pre-auth limiter for ip1.
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      makeSessionClient({ user: null }) as any,
    );
    for (let i = 0; i < 30; i++) {
      const req = makeRequest("/api/admin/products", {
        method: "POST",
        headers: { "x-edgeone-client-ip": ip1 },
        body: { name: "test" },
      });
      await requireAdminWrite(req, { maxBytes: 1024 * 1024 });
    }

    // A request from ip2 should still be allowed (separate bucket).
    vi.mocked(createServerSupabaseClient).mockClear();
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      makeSessionClient({ user: mockUser }) as any,
    );

    const req = makeRequest("/api/admin/products", {
      method: "POST",
      headers: { "x-edgeone-client-ip": ip2 },
      body: { name: "test" },
    });
    const result = await requireAdminWrite(req, { maxBytes: 1024 * 1024 });

    expect(result.ok).toBe(true);
    expect(createServerSupabaseClient).toHaveBeenCalled();
  });

  it("4. does NOT trust x-forwarded-for (only TRUSTED_PROXY_HEADER)", async () => {
    // TRUSTED_PROXY_HEADER is NOT configured — all proxy headers untrusted.
    vi.stubEnv("TRUSTED_PROXY_HEADER", "");

    // Exhaust the fallback:global bucket (30 req / 60s).
    // x-forwarded-for is present but NOT trusted, so all requests
    // fall into the shared fallback:global bucket.
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      makeSessionClient({ user: null }) as any,
    );
    for (let i = 0; i < 30; i++) {
      const req = makeRequest("/api/admin/products", {
        method: "POST",
        headers: { "x-forwarded-for": `203.0.113.${i}` },
        body: { name: "test" },
      });
      await requireAdminWrite(req, { maxBytes: 1024 * 1024 });
    }

    // 31st request with a DIFFERENT x-forwarded-for should still be
    // blocked — x-forwarded-for is NOT trusted, so all unknown-IP
    // requests share the fallback:global bucket.
    vi.mocked(createServerSupabaseClient).mockClear();
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      makeSessionClient({ user: mockUser }) as any,
    );

    const req = makeRequest("/api/admin/products", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.99" },
      body: { name: "test" },
    });
    const result = await requireAdminWrite(req, { maxBytes: 1024 * 1024 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(429);
    }
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });
});

describe("KZQ-P1-010: Pre-auth rate limiting — requireAdminRead", () => {
  it("5. returns 429 WITHOUT calling getVerifiedAdmin() when pre-auth limit exceeded", async () => {
    const ip = uniqueIp();

    // Exhaust the pre-auth limiter for this IP.
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      makeSessionClient({ user: null }) as any,
    );
    for (let i = 0; i < 30; i++) {
      const req = makeRequest("/api/admin/products", {
        method: "GET",
        headers: { "x-edgeone-client-ip": ip },
      });
      await requireAdminRead(req);
    }

    // 31st request — should be blocked at pre-auth.
    vi.mocked(createServerSupabaseClient).mockClear();
    vi.mocked(createServerSupabaseClient).mockReturnValue(
      makeSessionClient({ user: mockUser }) as any,
    );

    const req = makeRequest("/api/admin/products", {
      method: "GET",
      headers: { "x-edgeone-client-ip": ip },
    });
    const result = await requireAdminRead(req);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(429);
      const body = await result.response.json();
      expect(body.error).toBe("ADMIN_WRITE_RATE_LIMITED");
    }
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });

  it("6. calls getVerifiedAdmin() when pre-auth limit is NOT exceeded", async () => {
    const ip = uniqueIp();
    const req = makeRequest("/api/admin/products", {
      method: "GET",
      headers: { "x-edgeone-client-ip": ip },
    });
    const result = await requireAdminRead(req);
    expect(result.ok).toBe(true);
    expect(createServerSupabaseClient).toHaveBeenCalled();
  });
});

describe("KZQ-P1-010: getAdminPreAuthRateLimiter factory", () => {
  it("7. returns a singleton limiter (same instance across calls)", () => {
    const a = getAdminPreAuthRateLimiter();
    const b = getAdminPreAuthRateLimiter();
    expect(a).toBe(b); // referential equality — singleton
  });

  it("8. limiter enforces 30 req / 60s limit", async () => {
    const limiter = getAdminPreAuthRateLimiter();
    // Use a unique key to avoid interference with other tests.
    const key = `ip:192.0.2.${Date.now() % 256}`;

    // 30 requests should all be allowed.
    for (let i = 0; i < 30; i++) {
      const result = await limiter.check(key);
      expect(result.allowed).toBe(true);
    }
    // 31st request should be blocked.
    const result = await limiter.check(key);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });
});
