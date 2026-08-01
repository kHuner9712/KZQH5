import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  checkRateLimitKeys,
  ephemeralRateKey,
  ephemeralRateKeySet,
  getClientIp,
} from "@/lib/services/http-security";
import {
  MemoryRateLimiter,
  PostgresRateLimiter,
  createRateLimiter,
  getRateLimitDriver,
} from "@/lib/services/rate-limit";

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

  // ============================================================
  // Review #4 — Phase 1 Task 1: window-expiration reset bug.
  //
  // The previous `check()` incremented the existing entry's count
  // WITHOUT first verifying the entry was still within its window.
  // When the global cleanup throttle had not yet fired, an expired
  // entry could continue to accumulate counts, causing legitimate
  // requests AFTER the window ended to be rate-limited.
  //
  // The fix: after reading the existing entry, check whether
  // `now - firstRequestAt >= windowMs`. If so, treat the request as
  // the first request of a NEW window: remove the stale entry from
  // the map + linked list, insert a fresh entry, and return the
  // correct allowed/remaining/retryAfter values.
  // ============================================================

  it("resets the window immediately when it has exactly expired", async () => {
    // Verifies the boundary condition: when now - firstRequestAt === windowMs
    // exactly, the entry is treated as expired and the window resets.
    let now = 0;
    const limiter = new MemoryRateLimiter(2, 10_000, () => now);
    expect((await limiter.check("k")).allowed).toBe(true); // count=1
    expect((await limiter.check("k")).allowed).toBe(true); // count=2
    expect((await limiter.check("k")).allowed).toBe(false); // count=3, over-limit

    // Advance to exactly the window boundary. The entry has expired
    // (10000 - 0 >= 10000). Whether cleanup runs or not, the next
    // check("k") MUST return a fresh window with count=1.
    now = 10_000;
    const result = await limiter.check("k");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1); // 2 - 1 = 1 (fresh window, count=1)
    expect(result.retryAfterSeconds).toBe(10); // full window remaining
  });

  it("resets the window when expired even when cleanup throttle has NOT fired (the core bug)", async () => {
    // Construct the exact scenario where the bug manifests:
    //   - windowMs large enough that throttle (windowMs/4) is also large
    //   - A recent cleanup has advanced lastCleanupAt
    //   - The entry is expired but the throttle window hasn't elapsed
    //
    // windowMs = 10s, throttle = max(2500, 1000) = 2500.
    let now = 0;
    const limiter = new MemoryRateLimiter(2, 10_000, () => now);
    // t=0: over-limit the key.
    await limiter.check("k"); // count=1, allowed
    await limiter.check("k"); // count=2, allowed
    await limiter.check("k"); // count=3, BLOCKED

    // t=8000: a different key forces cleanup to run (8000-0=8000 >= 2500).
    // lastCleanupAt becomes 8000. The "k" entry is NOT expired
    // (8000-0=8000 < 10000) so it survives cleanup.
    now = 8_000;
    await limiter.check("other");

    // t=10001: "k" IS expired (10001-0 >= 10000) but the cleanup
    // throttle has NOT fired (10001-8000=2001 < 2500). The previous
    // implementation would increment the stale entry's count to 4
    // and return allowed=false — the BUG.
    now = 10_001;
    const result = await limiter.check("k");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1); // fresh window: maximum(2) - 1 = 1
    expect(result.retryAfterSeconds).toBe(10); // fresh window → full window
  });

  it("returns correct remaining after reset (fresh window)", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(5, 10_000, () => now);
    // Use 3 of 5.
    await limiter.check("k"); // count=1, remaining=4
    await limiter.check("k"); // count=2, remaining=3
    await limiter.check("k"); // count=3, remaining=2
    // Expire the window. Use a second key to advance lastCleanupAt
    // close to the expiry so the throttle doesn't fire on the next
    // "k" check.
    now = 8_000;
    await limiter.check("other"); // triggers cleanup (8000>=2500), lastCleanupAt=8000
    now = 10_001; // "k" expired, throttle not fired (10001-8000=2001<2500)
    const result = await limiter.check("k");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4); // 5 - 1 = 4 (fresh window)
  });

  it("returns correct retryAfterSeconds after reset (full window)", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(1, 10_000, () => now);
    await limiter.check("k"); // count=1, allowed
    now = 8_000;
    await limiter.check("other"); // lastCleanupAt=8000
    now = 10_001; // "k" expired, throttle not fired
    const result = await limiter.check("k");
    expect(result.allowed).toBe(true);
    // Fresh window: full windowMs remaining → 10s.
    expect(result.retryAfterSeconds).toBe(10);
  });

  it("reset does not corrupt entryCount or the linked list", async () => {
    // Insert several keys, force one to expire mid-list, and verify
    // that entryCount stays consistent and subsequent capacity
    // checks still work without crashing or duplicating entries.
    let now = 0;
    const limiter = new MemoryRateLimiter(1, 10_000, () => now, 5);
    // Insert 5 keys at t=0 (capacity reached).
    await limiter.check("a");
    await limiter.check("b");
    await limiter.check("c");
    await limiter.check("d");
    await limiter.check("e");
    expect(limiter.entryCount()).toBe(5);

    // Force a cleanup at t=8000 (doesn't expire any, all at firstRequestAt=0).
    now = 8_000;
    await limiter.check("force-cleanup"); // FAIL_SAFE: capacity, rejected
    // lastCleanupAt is now 8000; "force-cleanup" was NOT inserted.
    expect(limiter.entryCount()).toBe(5);

    // At t=10001, "c" is expired but cleanup throttle (2500) hasn't fired
    // (10001-8000=2001 < 2500). Re-checking "c" must reset it, not
    // duplicate it. entryCount must stay at 5 (c removed + re-inserted).
    now = 10_001;
    const result = await limiter.check("c");
    expect(result.allowed).toBe(true);
    expect(limiter.entryCount()).toBe(5);

    // The linked list must still be valid. A new key check forces the
    // capacity tail-walk: a/b/d/e are all expired (firstRequestAt=0,
    // 10001-0 >= 10000) and get evicted, making room for "new-key".
    // "c" (firstRequestAt=10001) is live and survives. This proves the
    // prev/next pointers are intact after the reset.
    const overflow = await limiter.check("new-key");
    expect(overflow.allowed).toBe(true);
    // After evicting 4 expired entries and inserting "new-key":
    // "c" (live) + "new-key" = 2 entries.
    expect(limiter.entryCount()).toBe(2);

    // A subsequent capacity fail-safe must still work: fill back up to
    // 5 with LIVE entries and verify a 6th is rejected.
    now = 10_002;
    await limiter.check("p1");
    await limiter.check("p2");
    await limiter.check("p3");
    expect(limiter.entryCount()).toBe(5);
    const rejected = await limiter.check("p4");
    expect(rejected.allowed).toBe(false);
    expect(limiter.entryCount()).toBe(5);
  });

  it("capacity fail-safe behavior is preserved after a reset", async () => {
    // Verify that resetting an expired entry doesn't accidentally
    // bypass the capacity fail-safe. Capacity = 3, maximum = 1.
    let now = 0;
    const limiter = new MemoryRateLimiter(1, 1_000, () => now, 3);
    await limiter.check("a"); // count=1, allowed
    await limiter.check("b"); // count=1, allowed
    await limiter.check("c"); // count=1, allowed
    expect(limiter.entryCount()).toBe(3);
    // "d" must be rejected (fail-safe) and must NOT evict live entries.
    expect((await limiter.check("d")).allowed).toBe(false);
    expect(limiter.entryCount()).toBe(3);

    // Advance past the window AND the cleanup throttle so all entries
    // are expired and cleanup runs. Now a new key should be admitted.
    now = 5_001;
    const result = await limiter.check("d");
    expect(result.allowed).toBe(true);
    expect(limiter.entryCount()).toBe(1); // only "d" remains
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

    // ephemeralRateKey returns the FIRST key (the global floor:
    // fallback:dev in non-production). The HMAC sub-bucket is the
    // SECOND key — accessible via ephemeralRateKeySet.
    const firstSet = ephemeralRateKeySet({ headers: baseHeaders });
    const secondSet = ephemeralRateKeySet({ headers: baseHeaders });
    expect(firstSet.keys).toEqual(secondSet.keys);
    // The second key is the HMAC sub-bucket.
    expect(firstSet.keys.length).toBe(2);
    expect(firstSet.keys[1]).toMatch(/^fallback:[a-f0-9]{16}$/);

    // A different User-Agent should produce a different HMAC sub-bucket.
    const otherHeaders = new Headers(baseHeaders);
    otherHeaders.set("user-agent", "Mozilla/5.0 (Different)");
    const thirdSet = ephemeralRateKeySet({ headers: otherHeaders });
    expect(thirdSet.keys[1]).not.toBe(firstSet.keys[1]);
    // But the global floor (first key) is the same for both.
    expect(thirdSet.keys[0]).toBe(firstSet.keys[0]);
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

// ============================================================
// Two-layer rate-limit model (Review Round 3 WP1)
// ------------------------------------------------------------
// The HMAC fingerprint bucket is NO LONGER the only key for
// unknown-IP clients. A strict `fallback:global` floor is ALWAYS
// checked first. The HMAC sub-bucket (when configured) is an
// ADDITIONAL restriction on top of the global floor. An attacker
// rotating User-Agent / Accept-Language / Sec-Fetch-Mode cannot
// bypass the global floor.
// ============================================================
describe("ephemeralRateKeySet — two-layer model", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a single ip: key when a trusted IP is available", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "eo-connecting-ip");
    const headers = new Headers();
    headers.set("eo-connecting-ip", "203.0.113.10");
    const { keys } = ephemeralRateKeySet({ headers });
    expect(keys).toEqual(["ip:203.0.113.10"]);
  });

  it("includes the fallback:global floor in production even when secret is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "RATE_LIMIT_FALLBACK_SECRET",
      "super-secret-key-that-is-at-least-32-chars-long",
    );
    const headers = new Headers();
    headers.set("user-agent", "Mozilla/5.0 (Test)");
    const { keys } = ephemeralRateKeySet({ headers });
    expect(keys.length).toBe(2);
    expect(keys[0]).toBe("fallback:global");
    expect(keys[1]).toMatch(/^fallback:[a-f0-9]{16}$/);
  });

  it("returns only fallback:global in production when secret is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    const headers = new Headers();
    const { keys } = ephemeralRateKeySet({ headers });
    expect(keys).toEqual(["fallback:global"]);
  });

  it("returns only fallback:global in production when secret is too short", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMIT_FALLBACK_SECRET", "short-16-char-key");
    const headers = new Headers();
    const { keys } = ephemeralRateKeySet({ headers });
    expect(keys).toEqual(["fallback:global"]);
  });

  it("includes the HMAC sub-bucket in non-production when a secret is set", () => {
    // The HMAC sub-bucket is an additional restriction on top of the
    // global floor. It is added whenever the secret is configured,
    // regardless of NODE_ENV. In non-production the global floor is
    // `fallback:dev` (instead of `fallback:global`), but the sub-bucket
    // is still appended when the secret is present.
    vi.stubEnv(
      "RATE_LIMIT_FALLBACK_SECRET",
      "super-secret-key-that-is-at-least-32-chars-long",
    );
    const headers = new Headers();
    headers.set("user-agent", "Mozilla/5.0 (Test)");
    const { keys } = ephemeralRateKeySet({ headers });
    expect(keys.length).toBe(2);
    expect(keys[0]).toBe("fallback:dev");
    expect(keys[1]).toMatch(/^fallback:[a-f0-9]{16}$/);
  });
});

// ============================================================
// Header rotation bypass tests (Review Round 3 WP1)
// ------------------------------------------------------------
// An attacker rotating User-Agent, Accept-Language, and
// Sec-Fetch-Mode MUST be caught by the global floor. Even though
// each rotation produces a different HMAC sub-bucket key, the
// global floor is shared across ALL rotations, so the total
// request count is capped.
// ============================================================
describe("checkRateLimitKeys — header rotation bypass prevention", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rotating 100 User-Agents is caught by the global floor (production)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "RATE_LIMIT_FALLBACK_SECRET",
      "super-secret-key-that-is-at-least-32-chars-long",
    );
    // Limiter: 5 requests / 60s. The global floor caps ALL unknown-IP
    // clients to 5 requests total, regardless of header rotation.
    const limiter = new MemoryRateLimiter(5, 60_000);
    let allowedCount = 0;
    for (let i = 0; i < 100; i++) {
      const headers = new Headers();
      headers.set("user-agent", `Bot/${i}`);
      headers.set("accept-language", "en-US");
      headers.set("sec-fetch-mode", "navigate");
      const result = await checkRateLimitKeys({ headers }, limiter);
      if (result.allowed) allowedCount++;
    }
    // The global floor (5/60s) must have capped the total allowed
    // requests to at most 5, despite 100 different User-Agents.
    expect(allowedCount).toBeLessThanOrEqual(5);
  });

  it("rotating Accept-Language cannot bypass the global floor", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "RATE_LIMIT_FALLBACK_SECRET",
      "super-secret-key-that-is-at-least-32-chars-long",
    );
    const limiter = new MemoryRateLimiter(3, 60_000);
    let allowedCount = 0;
    for (let i = 0; i < 50; i++) {
      const headers = new Headers();
      headers.set("user-agent", "Mozilla/5.0");
      headers.set("accept-language", `en-${i.toString().padStart(2, "0")}`);
      headers.set("sec-fetch-mode", "navigate");
      const result = await checkRateLimitKeys({ headers }, limiter);
      if (result.allowed) allowedCount++;
    }
    expect(allowedCount).toBeLessThanOrEqual(3);
  });

  it("rotating Sec-Fetch-Mode cannot bypass the global floor", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "RATE_LIMIT_FALLBACK_SECRET",
      "super-secret-key-that-is-at-least-32-chars-long",
    );
    const limiter = new MemoryRateLimiter(3, 60_000);
    let allowedCount = 0;
    const modes = ["navigate", "cors", "no-cors", "same-origin", "websocket"];
    for (let i = 0; i < 50; i++) {
      const headers = new Headers();
      headers.set("user-agent", "Mozilla/5.0");
      headers.set("accept-language", "en-US");
      headers.set("sec-fetch-mode", modes[i % modes.length]!);
      const result = await checkRateLimitKeys({ headers }, limiter);
      if (result.allowed) allowedCount++;
    }
    expect(allowedCount).toBeLessThanOrEqual(3);
  });

  it("global floor is enforced even when HMAC secret is configured", async () => {
    // The secret does NOT cancel the global protection.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "RATE_LIMIT_FALLBACK_SECRET",
      "super-secret-key-that-is-at-least-32-chars-long",
    );
    const limiter = new MemoryRateLimiter(2, 60_000);
    // First two requests (same headers) are allowed.
    const headers = new Headers();
    headers.set("user-agent", "Mozilla/5.0");
    headers.set("accept-language", "en-US");
    expect((await checkRateLimitKeys({ headers }, limiter)).allowed).toBe(true);
    expect((await checkRateLimitKeys({ headers }, limiter)).allowed).toBe(true);
    // Third request (same headers) is blocked by BOTH the global floor
    // AND the HMAC sub-bucket.
    expect((await checkRateLimitKeys({ headers }, limiter)).allowed).toBe(false);
    // Fourth request with DIFFERENT headers: the HMAC sub-bucket is
    // fresh, but the global floor is still exhausted → blocked.
    const rotatedHeaders = new Headers();
    rotatedHeaders.set("user-agent", "Different/1.0");
    rotatedHeaders.set("accept-language", "fr-FR");
    expect(
      (await checkRateLimitKeys({ headers: rotatedHeaders }, limiter)).allowed,
    ).toBe(false);
  });

  it("trusted-IP requests do NOT enter the global floor bucket", async () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "eo-connecting-ip");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "RATE_LIMIT_FALLBACK_SECRET",
      "super-secret-key-that-is-at-least-32-chars-long",
    );
    const limiter = new MemoryRateLimiter(2, 60_000);
    // Two different trusted IPs: each gets its own ip: bucket, neither
    // touches fallback:global.
    const h1 = new Headers();
    h1.set("eo-connecting-ip", "203.0.113.1");
    const h2 = new Headers();
    h2.set("eo-connecting-ip", "203.0.113.2");
    expect((await checkRateLimitKeys({ headers: h1 }, limiter)).allowed).toBe(true);
    expect((await checkRateLimitKeys({ headers: h2 }, limiter)).allowed).toBe(true);
    // A third request from a THIRD IP should also be allowed (each IP
    // has its own bucket). This proves trusted IPs are not subject to
    // the shared global floor.
    const h3 = new Headers();
    h3.set("eo-connecting-ip", "203.0.113.3");
    expect((await checkRateLimitKeys({ headers: h3 }, limiter)).allowed).toBe(true);
  });

  it("invalid TRUSTED_PROXY_HEADER configuration fail-closed to the global floor", async () => {
    // An invalid header name → getClientIp returns null → enters the
    // unknown-source path with the global floor.
    vi.stubEnv("TRUSTED_PROXY_HEADER", "x-attacker-controlled-ip");
    vi.stubEnv("NODE_ENV", "production");
    const limiter = new MemoryRateLimiter(2, 60_000);
    const headers = new Headers();
    headers.set("x-attacker-controlled-ip", "203.0.113.99");
    expect((await checkRateLimitKeys({ headers }, limiter)).allowed).toBe(true);
    expect((await checkRateLimitKeys({ headers }, limiter)).allowed).toBe(true);
    expect((await checkRateLimitKeys({ headers }, limiter)).allowed).toBe(false);
  });

  it("empty queue still returns an allowed result (no false 429)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const limiter = new MemoryRateLimiter(5, 60_000);
    const headers = new Headers();
    const result = await checkRateLimitKeys({ headers }, limiter);
    expect(result.allowed).toBe(true);
  });
});

// ============================================================
// KZQ-P1-011-b: PostgreSQL distributed rate limiter
// ------------------------------------------------------------
// PostgresRateLimiter delegates to the `rate_limit_check` RPC
// (migration 20260801000000_distributed_rate_limit_rpc.sql).
//
// Failure policy (P1-011-a decision matrix): transport error / null /
// malformed / ok !== true → FAIL-OPEN (allowed). EdgeOne WAF provides
// the cross-instance floor in production. The limiter NEVER throws.
// ============================================================
describe("postgres rate limiter (KZQ-P1-011-b)", () => {
  it("forwards bucket, key, maxCount, and window seconds to the RPC", async () => {
    const transport = vi.fn().mockResolvedValue({
      data: { ok: true, allowed: true, remaining: 4, retry_after_seconds: 0 },
      error: null,
    });
    const limiter = new PostgresRateLimiter("inquiry", 5, 60_000, transport);
    await limiter.check("ip:203.0.113.10");
    expect(transport).toHaveBeenCalledTimes(1);
    const args = transport.mock.calls[0];
    expect(args?.[0]).toBe("inquiry");
    expect(args?.[1]).toBe("ip:203.0.113.10");
    expect(args?.[2]).toBe(5);
    // windowMs 60000 → 60s
    expect(args?.[3]).toBe(60);
  });

  it("rounds sub-second windows up to at least 1 second", async () => {
    const transport = vi.fn().mockResolvedValue({
      data: { ok: true, allowed: true, remaining: 1, retry_after_seconds: 0 },
      error: null,
    });
    const limiter = new PostgresRateLimiter("b", 1, 500, transport);
    await limiter.check("k");
    expect(transport.mock.calls[0]?.[3]).toBe(1);
    await new PostgresRateLimiter("b", 1, 1_500, transport).check("k");
    expect(transport.mock.calls[1]?.[3]).toBe(2);
  });

  it("returns the RPC decision when ok=true and allowed=false", async () => {
    const transport = vi.fn().mockResolvedValue({
      data: {
        ok: true,
        allowed: false,
        remaining: 0,
        retry_after_seconds: 42,
      },
      error: null,
    });
    const limiter = new PostgresRateLimiter("b", 3, 60_000, transport);
    const result = await limiter.check("k");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSeconds).toBe(42);
  });

  it("returns remaining from a successful RPC decision", async () => {
    const transport = vi.fn().mockResolvedValue({
      data: { ok: true, allowed: true, remaining: 2, retry_after_seconds: 0 },
      error: null,
    });
    const limiter = new PostgresRateLimiter("b", 3, 60_000, transport);
    const result = await limiter.check("k");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
    expect(result.retryAfterSeconds).toBe(0);
  });

  it("fail-opens on RPC transport error", async () => {
    const transport = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "connection refused" },
    });
    const limiter = new PostgresRateLimiter("b", 3, 60_000, transport);
    const result = await limiter.check("k");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
    expect(result.retryAfterSeconds).toBe(0);
  });

  it("fail-opens on null RPC response (no transport error)", async () => {
    const transport = vi.fn().mockResolvedValue({ data: null, error: null });
    const limiter = new PostgresRateLimiter("b", 3, 60_000, transport);
    const result = await limiter.check("k");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
  });

  it("fail-opens when the RPC returns ok !== true (business failure)", async () => {
    const transport = vi.fn().mockResolvedValue({
      data: { ok: false, error: "invalid_bucket" },
      error: null,
    });
    const limiter = new PostgresRateLimiter("b", 3, 60_000, transport);
    const result = await limiter.check("k");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
  });

  it("fail-opens on malformed structure (missing ok)", async () => {
    const transport = vi.fn().mockResolvedValue({
      data: { allowed: true },
      error: null,
    });
    const limiter = new PostgresRateLimiter("b", 3, 60_000, transport);
    const result = await limiter.check("k");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
  });

  it("fail-opens on non-object RPC data", async () => {
    const transport = vi.fn().mockResolvedValue({ data: "garbage", error: null });
    const limiter = new PostgresRateLimiter("b", 3, 60_000, transport);
    const result = await limiter.check("k");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
  });

  it("fail-opens when the transport throws (never throws to callers)", async () => {
    const transport = vi.fn().mockRejectedValue(new Error("network down"));
    const limiter = new PostgresRateLimiter("b", 3, 60_000, transport);
    // If check() ever propagated the rejection, this await would throw
    // and the test would fail — proving it never throws to callers.
    const result = await limiter.check("k");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
    expect(result.retryAfterSeconds).toBe(0);
  });
});

describe("rate-limit driver selection (KZQ-P1-011-b)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("getRateLimitDriver returns postgres when RATE_LIMIT_DRIVER=postgres", () => {
    vi.stubEnv("RATE_LIMIT_DRIVER", "postgres");
    expect(getRateLimitDriver()).toBe("postgres");
  });

  it("getRateLimitDriver returns memory when unset", () => {
    vi.stubEnv("RATE_LIMIT_DRIVER", "");
    expect(getRateLimitDriver()).toBe("memory");
  });

  it("getRateLimitDriver rejects unknown values without silently switching", () => {
    // Only the exact string "postgres" enables the distributed driver;
    // any other value falls back to memory (no silent behavior change).
    for (const value of ["POSTGRES", "Postgres", "redis", "1", "true"]) {
      vi.stubEnv("RATE_LIMIT_DRIVER", value);
      expect(getRateLimitDriver()).toBe("memory");
    }
  });

  it("createRateLimiter returns a PostgresRateLimiter under the postgres driver", () => {
    vi.stubEnv("RATE_LIMIT_DRIVER", "postgres");
    expect(createRateLimiter("b", 5, 60_000)).toBeInstanceOf(PostgresRateLimiter);
  });

  it("createRateLimiter returns a MemoryRateLimiter by default", () => {
    vi.stubEnv("RATE_LIMIT_DRIVER", "");
    expect(createRateLimiter("b", 5, 60_000)).toBeInstanceOf(MemoryRateLimiter);
  });
});
