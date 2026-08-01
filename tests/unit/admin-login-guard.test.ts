import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { LOGIN_ERROR_MESSAGES } from "@/lib/security/login-errors";

// ============================================================
// KZQ-P1-021: admin login brute-force protection — server guard
//
// Verifies the /api/admin/login-guard endpoint:
//   - allows attempts under the limit (200 { ok: true })
//   - returns 429 with the fixed Chinese message + Retry-After after
//     the limit is hit
//   - per-IP buckets are independent
//   - unknown-IP clients share the global floor (header rotation
//     cannot bypass)
//   - 429 responses are never cached (Cache-Control: no-store)
// ============================================================

const GUARD_URL = "https://kzq.test/api/admin/login-guard";

/**
 * Reload the route module so the module-level singleton limiter is
 * reset between tests (getLoginRateLimiter caches one instance).
 */
async function loadPost() {
  vi.resetModules();
  const mod = await import("@/app/api/admin/login-guard/route");
  return mod.POST;
}

function makeRequest(ip?: string, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extraHeaders };
  if (ip) headers["eo-connecting-ip"] = ip;
  return new NextRequest(GUARD_URL, { method: "POST", headers });
}

describe("admin login guard (KZQ-P1-021)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("TRUSTED_PROXY_HEADER", "eo-connecting-ip");
    vi.stubEnv("NODE_ENV", "production");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows login attempts under the limit (200 ok, no-store)", async () => {
    const POST = await loadPost();
    for (let i = 0; i < 5; i++) {
      const res = await POST(makeRequest("203.0.113.10"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("blocks the 6th attempt within a minute (429 + fixed message + Retry-After)", async () => {
    const POST = await loadPost();
    for (let i = 0; i < 5; i++) {
      await POST(makeRequest("203.0.113.11"));
    }
    const res = await POST(makeRequest("203.0.113.11"));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe(LOGIN_ERROR_MESSAGES.RATE_LIMITED);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("keeps per-IP buckets independent", async () => {
    const POST = await loadPost();
    // Exhaust IP A.
    for (let i = 0; i < 5; i++) {
      await POST(makeRequest("203.0.113.20"));
    }
    expect((await POST(makeRequest("203.0.113.20"))).status).toBe(429);
    // IP B is unaffected.
    const res = await POST(makeRequest("203.0.113.21"));
    expect(res.status).toBe(200);
  });

  it("unknown-IP clients share the global floor (header rotation cannot bypass)", async () => {
    // No trusted IP header configured → every client maps to the
    // shared fallback:global floor (production, no HMAC secret).
    vi.stubEnv("TRUSTED_PROXY_HEADER", "");
    const POST = await loadPost();
    let blockedAfter5 = true;
    for (let i = 0; i < 6; i++) {
      const res = await POST(
        makeRequest(undefined, {
          "user-agent": `Bot/${i}`,
          "accept-language": "en-US",
          "sec-fetch-mode": "navigate",
        }),
      );
      if (i < 5) {
        expect(res.status).toBe(200);
      } else {
        blockedAfter5 = res.status === 429;
      }
    }
    expect(blockedAfter5).toBe(true);
  });

  it("ignores the request body entirely (no credentials are read)", async () => {
    const POST = await loadPost();
    const req = new NextRequest(GUARD_URL, {
      method: "POST",
      headers: { "eo-connecting-ip": "203.0.113.30" },
      body: JSON.stringify({ email: "admin@kzq.com", password: "secret" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});
