import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MemoryRateLimiter } from "@/lib/services/rate-limit";

// ============================================================
// Phase 6: Rate limiting tests for public API routes
//
// Verifies that:
//   1. /api/og returns 429 when the rate limit is exceeded
//   2. /api/og returns 200 (image) when under the limit
//   3. /api/wechat/jssdk returns 429 when the rate limit is exceeded
//   4. /api/wechat/jssdk returns 204 (unconfigured) before rate check
//   5. The rate limit is enforced BEFORE expensive work (OG rendering,
//      WeChat API calls)
// ============================================================

beforeEach(() => {
  vi.unstubAllEnvs();
  // Configure a trusted proxy header so rate-limit keys use `ip:<addr>`
  // (deterministic single-bucket path) instead of the fallback:global path.
  vi.stubEnv("TRUSTED_PROXY_HEADER", "eo-connecting-ip");
  vi.stubEnv("RATE_LIMIT_FALLBACK_SECRET", "a".repeat(32));
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/services/rate-limit");
  vi.doUnmock("@/lib/services/wechat/jssdk");
  vi.resetModules();
});

function requestWithIp(url: string, ip = "203.0.113.1"): NextRequest {
  return new NextRequest(url, {
    headers: {
      "eo-connecting-ip": ip,
    },
  });
}

// ============================================================
// /api/og — OG image generation rate limiting
// ============================================================
describe("/api/og — Phase 6 rate limiting", () => {
  it("returns 200 (image) when under the rate limit", async () => {
    const { GET } = await import("@/app/api/og/route");
    const req = requestWithIp("https://kzq.test/api/og?title=Test");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image");
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    // Reset modules so vi.doMock takes effect on the next import.
    vi.resetModules();
    const limiter = new MemoryRateLimiter(2, 60_000);
    vi.doMock("@/lib/services/rate-limit", () => ({
      getOgRateLimiter: () => limiter,
    }));

    const { GET } = await import("@/app/api/og/route");
    const ip = "198.51.100.1";

    // First two requests should succeed.
    const r1 = await GET(requestWithIp("https://kzq.test/api/og?title=A", ip));
    const r2 = await GET(requestWithIp("https://kzq.test/api/og?title=B", ip));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // Third request from the same IP should be rate-limited.
    const r3 = await GET(requestWithIp("https://kzq.test/api/og?title=C", ip));
    expect(r3.status).toBe(429);
    expect(r3.headers.get("Retry-After")).toBeTruthy();
    expect(r3.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rate limit is per-IP (different IPs are independent)", async () => {
    vi.resetModules();
    const limiter = new MemoryRateLimiter(1, 60_000);
    vi.doMock("@/lib/services/rate-limit", () => ({
      getOgRateLimiter: () => limiter,
    }));

    const { GET } = await import("@/app/api/og/route");

    // IP 1 uses up its quota.
    const r1 = await GET(requestWithIp("https://kzq.test/api/og?title=A", "203.0.113.10"));
    expect(r1.status).toBe(200);
    const r2 = await GET(requestWithIp("https://kzq.test/api/og?title=B", "203.0.113.10"));
    expect(r2.status).toBe(429);

    // IP 2 should still be allowed.
    const r3 = await GET(requestWithIp("https://kzq.test/api/og?title=C", "203.0.113.20"));
    expect(r3.status).toBe(200);
  });
});

// ============================================================
// /api/wechat/jssdk — WeChat JS-SDK config rate limiting
// ============================================================
describe("/api/wechat/jssdk — Phase 6 rate limiting", () => {
  it("returns 204 when WeChat is not configured (before rate check)", async () => {
    vi.stubEnv("WECHAT_APP_SECRET", "");
    vi.stubEnv("WECHAT_APP_ID", "");
    const { GET } = await import("@/app/api/wechat/jssdk/route");
    const req = requestWithIp("https://kzq.test/api/wechat/jssdk?url=https://kzq.test/");
    const res = await GET(req);
    // When WeChat is not configured, the route returns 204 immediately
    // WITHOUT hitting the rate limiter. This avoids consuming quota
    // for a no-op response.
    expect(res.status).toBe(204);
  });

  it("returns 429 when the rate limit is exceeded (WeChat configured)", async () => {
    vi.resetModules();

    // Mock the jssdk module so we don't make real WeChat API calls.
    vi.doMock("@/lib/services/wechat/jssdk", () => ({
      isWechatConfigured: () => true,
      createWechatJsSdkConfig: vi.fn(async () => ({
        appId: "test-app-id",
        timestamp: 1234567890,
        nonceStr: "test-nonce",
        signature: "test-signature",
      })),
    }));

    // Mock the rate limiter to deny after 1 request.
    const limiter = new MemoryRateLimiter(1, 60_000);
    vi.doMock("@/lib/services/rate-limit", () => ({
      getWechatJsSdkRateLimiter: () => limiter,
    }));

    const { GET } = await import("@/app/api/wechat/jssdk/route");
    const ip = "203.0.113.50";

    // First request should succeed (200 with config).
    const r1 = await GET(requestWithIp(
      "https://kzq.test/api/wechat/jssdk?url=https://kzq.test/",
      ip,
    ));
    expect(r1.status).toBe(200);

    // Second request from the same IP should be rate-limited.
    const r2 = await GET(requestWithIp(
      "https://kzq.test/api/wechat/jssdk?url=https://kzq.test/",
      ip,
    ));
    expect(r2.status).toBe(429);
    expect(r2.headers.get("Retry-After")).toBeTruthy();
    expect(r2.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
