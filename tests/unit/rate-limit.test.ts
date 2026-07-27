import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  ephemeralRateKey,
  getClientIp,
} from "@/lib/services/http-security";
import { MemoryRateLimiter } from "@/lib/services/rate-limit";

describe("memory rate limiter", () => {
  it("allows requests in the window and rejects over-limit requests", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(2, 1000, () => now);
    expect((await limiter.check("client")).allowed).toBe(true);
    expect((await limiter.check("client")).allowed).toBe(true);
    expect((await limiter.check("client")).allowed).toBe(false);
    now = 1000;
    expect((await limiter.check("client")).allowed).toBe(true);
  });

  it("cleans expired records lazily (no per-request full scan)", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(2, 1000, () => now);
    await limiter.check("old"); // inserted at t=0, expires at t=1000
    now = 1001;
    await limiter.check("new"); // forces cleanup interval (1001 >= 1000):
    //                               evicts "old". "new" expires at t=2001.
    // Now advance to t=1500 — within the cleanup interval (1500-1001=499
    // < 1000) so no cleanup runs, AND "new" has not expired. A new key
    // should be admitted without evicting "new".
    now = 1500;
    await limiter.check("trigger");
    expect(limiter.entryCount()).toBe(2); // "new" + "trigger"

    // Forcing a cleanup past the window SHOULD evict "new" but keep
    // "trigger" (inserted at t=1500, alive for <1000ms at t=2400).
    now = 2400; // 1500 + 900 = past cleanup interval but "trigger" still alive
    await limiter.check("after");
    expect(limiter.entryCount()).toBe(2); // "trigger" + "after"
  });

  it("returns a positive retryAfterSeconds when the limit is hit", async () => {
    const now = () => 5_000;
    const limiter = new MemoryRateLimiter(1, 10_000, now);
    const first = await limiter.check("k");
    expect(first.allowed).toBe(true);
    const second = await limiter.check("k");
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("fail-safes (rejects new keys) when at capacity, without evicting live entries", async () => {
    // Capacity = 3, window = 10s, maximum = 1 per key.
    let now = 0;
    const limiter = new MemoryRateLimiter(1, 10_000, () => now, 3);
    // Fill to capacity with three DIFFERENT live keys.
    await limiter.check("a");
    await limiter.check("b");
    await limiter.check("c");
    expect(limiter.entryCount()).toBe(3);

    // A fourth NEW key must be rejected (fail-safe) and must NOT evict
    // any of the live entries.
    const result = await limiter.check("d");
    expect(result.allowed).toBe(false);
    expect(limiter.entryCount()).toBe(3);

    // The existing live entries are untouched.
    const a2 = await limiter.check("a");
    expect(a2.allowed).toBe(false); // already over-limit (count=2)
  });

  it("admits new keys after capacity evicts only EXPIRED entries", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(1, 1_000, () => now, 3);
    await limiter.check("a");
    await limiter.check("b");
    await limiter.check("c");
    expect(limiter.entryCount()).toBe(3);

    // Advance past the window so all entries are expired, then force a
    // lazy cleanup by advancing past the cleanup interval too.
    now = 5_001;
    // Trigger cleanup by checking a new key. The capacity check should
    // evict the three expired entries (tail walk) and admit the new one.
    const result = await limiter.check("d");
    expect(result.allowed).toBe(true);
    expect(limiter.entryCount()).toBe(1);
  });
});

describe("ephemeralRateKey — no-IP fallback strategy", () => {
  beforeEach(() => {
    // Reset all env vars that the function reads. vi.stubEnv/unstubAllEnvs
    // also work around the TS read-only typing of process.env.
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the configured TRUSTED_PROXY_HEADER IP when present", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "eo-connecting-ip");
    const headers = new Headers();
    headers.set("eo-connecting-ip", "203.0.113.10");
    expect(ephemeralRateKey({ headers })).toBe("ip:203.0.113.10");
  });

  it("does NOT trust client-forgeable x-forwarded-for (ever, no opt-in)", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "eo-connecting-ip");
    const headers = new Headers();
    headers.set("x-forwarded-for", "203.0.113.99");
    // x-forwarded-for is NEVER trusted, regardless of configuration.
    const key = ephemeralRateKey({ headers });
    expect(key).not.toContain("203.0.113.99");
  });

  it("returns a stable fallback key (NOT a random per-request UUID) when no IP is available", () => {
    const headers = new Headers();
    const first = ephemeralRateKey({ headers });
    const second = ephemeralRateKey({ headers });
    // Critical regression: the OLD code returned `unknown:<randomUUID>`,
    // which effectively disabled rate limiting. The new code MUST be
    // stable across calls.
    expect(first).toBe(second);
    expect(first).not.toMatch(/^unknown:/);
  });

  it("produces a stable HMAC fallback key when RATE_LIMIT_FALLBACK_SECRET is set (>= 32 chars)", () => {
    vi.stubEnv("RATE_LIMIT_FALLBACK_SECRET", "super-secret-key-that-is-at-least-32-chars-long");
    const baseHeaders = new Headers();
    baseHeaders.set("user-agent", "Mozilla/5.0 (Test Browser)");
    baseHeaders.set("accept-language", "en-US,en;q=0.9");

    const first = ephemeralRateKey({ headers: baseHeaders });
    const second = ephemeralRateKey({ headers: baseHeaders });
    expect(first).toBe(second);
    expect(first).toMatch(/^fallback:[a-f0-9]{16}$/);

    // A different User-Agent should produce a different bucket.
    const otherHeaders = new Headers(baseHeaders);
    otherHeaders.set("user-agent", "Mozilla/5.0 (Different)");
    const third = ephemeralRateKey({ headers: otherHeaders });
    expect(third).not.toBe(first);
  });

  it("falls back to a single strict global bucket in production when no secret is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    const headers = new Headers();
    const first = ephemeralRateKey({ headers });
    const second = ephemeralRateKey({ headers });
    expect(first).toBe("fallback:global");
    expect(second).toBe("fallback:global");
  });

  it("falls back to global when secret is shorter than 32 chars (even in non-production)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMIT_FALLBACK_SECRET", "short-16-char-key");
    const headers = new Headers();
    // 16 chars is no longer sufficient; must be >= 32.
    expect(ephemeralRateKey({ headers })).toBe("fallback:global");
  });

  it("ignores the legacy randomId parameter (no per-request UUID bypass)", () => {
    const headers = new Headers();
    // Even if a caller passes a randomId, the function MUST NOT use it.
    const first = ephemeralRateKey({ headers }, () => "first-random");
    const second = ephemeralRateKey({ headers }, () => "second-random");
    expect(first).toBe(second);
    expect(first).not.toContain("first-random");
    expect(first).not.toContain("second-random");
  });
});

describe("getClientIp — single configured trusted header", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns IP from the configured eo-connecting-ip header and ignores others", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "eo-connecting-ip");
    const headers = new Headers();
    headers.set("eo-connecting-ip", "203.0.113.10");
    // An attacker sets cf-connecting-ip — must be ignored.
    headers.set("cf-connecting-ip", "198.51.100.99");
    headers.set("x-forwarded-for", "203.0.113.99");
    expect(getClientIp({ headers })).toBe("203.0.113.10");
  });

  it("returns IP from the configured x-real-ip header and ignores others", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "x-real-ip");
    const headers = new Headers();
    headers.set("x-real-ip", "203.0.113.20");
    // Other trusted headers present — must be ignored.
    headers.set("eo-connecting-ip", "198.51.100.99");
    headers.set("cf-connecting-ip", "198.51.100.50");
    expect(getClientIp({ headers })).toBe("203.0.113.20");
  });

  it("returns null when TRUSTED_PROXY_HEADER is not configured (all proxy headers untrusted)", () => {
    const headers = new Headers();
    headers.set("eo-connecting-ip", "203.0.113.10");
    headers.set("cf-connecting-ip", "203.0.113.20");
    headers.set("x-real-ip", "203.0.113.30");
    headers.set("x-forwarded-for", "203.0.113.99");
    expect(getClientIp({ headers })).toBeNull();
  });

  it("returns null for an invalid TRUSTED_PROXY_HEADER value (fail closed)", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "x-attacker-controlled-ip");
    const headers = new Headers();
    headers.set("x-attacker-controlled-ip", "203.0.113.99");
    expect(getClientIp({ headers })).toBeNull();
  });

  it("returns null when the configured header is absent (does not fall through to other headers)", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "eo-connecting-ip");
    const headers = new Headers();
    // Only cf-connecting-ip is present, but we configured eo-connecting-ip.
    headers.set("cf-connecting-ip", "203.0.113.99");
    expect(getClientIp({ headers })).toBeNull();
  });

  it("returns null when the configured header value is not a valid IP", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "eo-connecting-ip");
    const headers = new Headers();
    headers.set("eo-connecting-ip", "not-an-ip");
    expect(getClientIp({ headers })).toBeNull();
  });

  it("multiple conflicting headers do not affect configured header priority", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "x-edgeone-client-ip");
    const headers = new Headers();
    headers.set("x-edgeone-client-ip", "203.0.113.42");
    // Attacker sets every other known proxy header to different values.
    headers.set("eo-connecting-ip", "10.0.0.1");
    headers.set("cf-connecting-ip", "10.0.0.2");
    headers.set("x-real-ip", "10.0.0.3");
    headers.set("x-forwarded-for", "10.0.0.4");
    expect(getClientIp({ headers })).toBe("203.0.113.42");
  });

  it("case-insensitive TRUSTED_PROXY_HEADER matching", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "EO-Connecting-IP");
    const headers = new Headers();
    headers.set("eo-connecting-ip", "203.0.113.42");
    expect(getClientIp({ headers })).toBe("203.0.113.42");
  });
});

// Sanity check: ensure the helpers integrate with a real NextRequest so
// the test does not rely on a hand-rolled Headers object only.
describe("integration with NextRequest", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("extracts a trusted IP from a real NextRequest using the configured header", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "eo-connecting-ip");
    const request = new NextRequest("https://kzq.test/api/inquiries", {
      headers: { "eo-connecting-ip": "203.0.113.42" },
    });
    expect(getClientIp(request)).toBe("203.0.113.42");
    expect(ephemeralRateKey(request)).toBe("ip:203.0.113.42");
  });

  it("returns null from a real NextRequest when header is not configured", () => {
    const request = new NextRequest("https://kzq.test/api/inquiries", {
      headers: { "eo-connecting-ip": "203.0.113.42" },
    });
    expect(getClientIp(request)).toBeNull();
    expect(ephemeralRateKey(request)).toMatch(/^fallback:/);
  });
});
