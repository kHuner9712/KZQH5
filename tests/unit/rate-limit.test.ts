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

  it("prefers a trusted proxy IP when present", () => {
    const headers = new Headers();
    headers.set("eo-connecting-ip", "203.0.113.10");
    expect(ephemeralRateKey({ headers })).toBe("ip:203.0.113.10");
  });

  it("does NOT trust client-forgeable x-forwarded-for by default", () => {
    const headers = new Headers();
    headers.set("x-forwarded-for", "203.0.113.99");
    // Without TRUST_X_FORWARDED_FOR=true, the header is ignored and the
    // fallback path is taken (dev bucket since NODE_ENV is not production).
    const key = ephemeralRateKey({ headers });
    expect(key).not.toContain("203.0.113.99");
  });

  it("honors TRUST_X_FORWARDED_FOR=true for the first hop only", () => {
    vi.stubEnv("TRUST_X_FORWARDED_FOR", "true");
    const headers = new Headers();
    headers.set("x-forwarded-for", "203.0.113.50, 10.0.0.1");
    expect(ephemeralRateKey({ headers })).toBe("ip:203.0.113.50");
  });

  it("rejects a malformed x-forwarded-for first hop", () => {
    vi.stubEnv("TRUST_X_FORWARDED_FOR", "true");
    const headers = new Headers();
    headers.set("x-forwarded-for", "not-an-ip, 10.0.0.1");
    // Falls back to non-IP path.
    expect(ephemeralRateKey({ headers })).toMatch(/^fallback:/);
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

  it("produces a stable HMAC fallback key when RATE_LIMIT_FALLBACK_SECRET is set", () => {
    vi.stubEnv("RATE_LIMIT_FALLBACK_SECRET", "super-secret-key-1234");
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

describe("getClientIp — header trust boundary", () => {
  it("trusts eo-connecting-ip first", () => {
    const headers = new Headers();
    headers.set("eo-connecting-ip", "203.0.113.10");
    headers.set("x-forwarded-for", "203.0.113.99");
    expect(getClientIp({ headers })).toBe("203.0.113.10");
  });

  it("rejects malformed trusted-header values", () => {
    const headers = new Headers();
    headers.set("eo-connecting-ip", "not-an-ip");
    expect(getClientIp({ headers })).toBeNull();
  });

  it("returns null when no trusted header is present and TRUST_X_FORWARDED_FOR is unset", () => {
    const headers = new Headers();
    headers.set("x-forwarded-for", "203.0.113.99");
    expect(getClientIp({ headers })).toBeNull();
  });
});

// Sanity check: ensure the helpers integrate with a real NextRequest so
// the test does not rely on a hand-rolled Headers object only.
describe("integration with NextRequest", () => {
  it("extracts a trusted IP from a real NextRequest", () => {
    const request = new NextRequest("https://kzq.test/api/inquiries", {
      headers: { "eo-connecting-ip": "203.0.113.42" },
    });
    expect(getClientIp(request)).toBe("203.0.113.42");
    expect(ephemeralRateKey(request)).toBe("ip:203.0.113.42");
  });
});
