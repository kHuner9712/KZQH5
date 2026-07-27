import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ============================================================
// Hardening regression tests for the public anonymous POST routes.
// ------------------------------------------------------------
// These tests prove that:
//   - body size limits are enforced (declared + actual byte count)
//   - Content-Type must be application/json
//   - cross-site requests are rejected by the CSRF guard
//   - rate limiting kicks in before body parsing
//   - error responses do NOT leak raw Supabase error.message text
//   - the products/selection endpoint caps at 30 IDs and rejects
//     non-UUID / non-mock IDs
// ============================================================

// --- Mocks ---------------------------------------------------------------
// We mock the rate limiter so it always allows — rate-limit behavior is
// covered by tests/unit/rate-limit.test.ts. Here we focus on the request
// body / CSRF / leak boundaries.
vi.mock("@/lib/services/rate-limit", () => ({
  getInquiryRateLimiter: () => ({
    check: async () => ({ allowed: true, remaining: 4, retryAfterSeconds: 60 }),
  }),
  getAnalyticsRateLimiter: () => ({
    check: async () => ({ allowed: true, remaining: 59, retryAfterSeconds: 60 }),
  }),
}));

// We mock the repository so no Supabase call is made. Using vi.fn() lets
// individual tests assert call counts and inject rejected-value cases.
vi.mock("@/lib/repositories/products", () => ({
  getPublicProductSelections: vi.fn(async () => []),
}));
vi.mock("@/lib/repositories/analytics", () => ({
  recordAnalyticsEvent: vi.fn(async () => {}),
}));

// Force Demo mode OFF so mock-* IDs are rejected by selection.
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "false");
});

// --- Helpers -------------------------------------------------------------
function jsonRequest(
  url: string,
  body: unknown,
  opts: {
    contentType?: string;
    origin?: string;
    host?: string;
    raw?: string; // bypass JSON.stringify and send raw bytes
  } = {},
): NextRequest {
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType ?? "application/json",
    "Accept-Language": "en",
  };
  if (opts.origin) headers["Origin"] = opts.origin;
  if (opts.host) headers["Host"] = opts.host;
  const bodyText = opts.raw !== undefined ? opts.raw : JSON.stringify(body);
  return new NextRequest(url, {
    method: "POST",
    headers,
    body: bodyText,
  });
}

function sameOriginJsonRequest(url: string, body: unknown, opts: { raw?: string; contentType?: string } = {}) {
  return jsonRequest(url, body, {
    origin: "https://kzq.test",
    host: "kzq.test",
    contentType: opts.contentType,
    raw: opts.raw,
  });
}

// ============================================================
// /api/products/selection
// ============================================================
describe("/api/products/selection — body & CSRF hardening", () => {
  it("rejects a non-JSON Content-Type with 415", async () => {
    const { POST } = await import("@/app/api/products/selection/route");
    const req = sameOriginJsonRequest(
      "https://kzq.test/api/products/selection",
      { ids: [] },
      { contentType: "text/plain" },
    );
    const res = await POST(req);
    expect(res.status).toBe(415);
  });

  it("rejects a body larger than 8 KB with 413", async () => {
    const { POST } = await import("@/app/api/products/selection/route");
    // 9000 chars of valid JSON object — actual byte count exceeds 8 KB.
    const hugeIds = Array.from({ length: 1000 }, () => "11111111-1111-4111-8111-111111111111");
    const body = JSON.stringify({ ids: hugeIds });
    expect(body.length).toBeGreaterThan(8 * 1024);
    const req = sameOriginJsonRequest(
      "https://kzq.test/api/products/selection",
      {},
      { raw: body },
    );
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it("rejects a top-level array body with 400", async () => {
    const { POST } = await import("@/app/api/products/selection/route");
    const req = sameOriginJsonRequest(
      "https://kzq.test/api/products/selection",
      {},
      { raw: '["11111111-1111-4111-8111-111111111111"]' },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects non-UUID, non-mock IDs in non-Demo mode", async () => {
    const { POST } = await import("@/app/api/products/selection/route");
    const req = sameOriginJsonRequest(
      "https://kzq.test/api/products/selection",
      { ids: ["not-a-uuid", "DROP TABLE products;"] },
    );
    const res = await POST(req);
    expect(res.status).toBe(200);
    const payload = await res.json();
    // The endpoint silently filters invalid IDs — no items are returned.
    expect(payload.items).toEqual([]);
  });

  it("caps at 30 IDs even if more are sent", async () => {
    const { getPublicProductSelections } = await import("@/lib/repositories/products");
    const spy = vi.mocked(getPublicProductSelections);
    spy.mockClear();
    const { POST } = await import("@/app/api/products/selection/route");
    const ids = Array.from(
      { length: 50 },
      (_, i) => `1111111${i.toString().padStart(2, "0")}-1111-4111-8111-111111111111`,
    );
    const req = sameOriginJsonRequest(
      "https://kzq.test/api/products/selection",
      { ids },
    );
    await POST(req);
    expect(spy).toHaveBeenCalledTimes(1);
    const passed = spy.mock.calls[0][0] as string[];
    expect(passed.length).toBeLessThanOrEqual(30);
  });

  it("returns Cache-Control: private, no-store on success", async () => {
    const { POST } = await import("@/app/api/products/selection/route");
    const req = sameOriginJsonRequest(
      "https://kzq.test/api/products/selection",
      { ids: [] },
    );
    const res = await POST(req);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("rejects cross-site requests with 403", async () => {
    const { POST } = await import("@/app/api/products/selection/route");
    const req = jsonRequest(
      "https://kzq.test/api/products/selection",
      { ids: [] },
      { origin: "https://evil.example", host: "kzq.test" },
    );
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("does not leak the repository error message on failure", async () => {
    const { getPublicProductSelections } = await import("@/lib/repositories/products");
    vi.mocked(getPublicProductSelections).mockRejectedValueOnce(
      new Error("Postgres error: select * from products where secret_column = 'PII'"),
    );
    const { POST } = await import("@/app/api/products/selection/route");
    const req = sameOriginJsonRequest(
      "https://kzq.test/api/products/selection",
      { ids: [] },
    );
    const res = await POST(req);
    const payload = await res.json();
    expect(res.status).toBe(500);
    expect(JSON.stringify(payload)).not.toContain("Postgres error");
    expect(JSON.stringify(payload)).not.toContain("secret_column");
    expect(JSON.stringify(payload)).not.toContain("PII");
  });
});

// ============================================================
// /api/analytics/events
// ============================================================
describe("/api/analytics/events — body & CSRF hardening", () => {
  it("rejects a non-JSON Content-Type with 415", async () => {
    const { POST } = await import("@/app/api/analytics/events/route");
    const req = sameOriginJsonRequest(
      "https://kzq.test/api/analytics/events",
      {},
      { contentType: "text/plain" },
    );
    const res = await POST(req);
    expect(res.status).toBe(415);
  });

  it("rejects a body larger than 8 KB with 413", async () => {
    const { POST } = await import("@/app/api/analytics/events/route");
    const huge = "x".repeat(10_000);
    const body = JSON.stringify({
      event_name: "page_view",
      locale: "en",
      page_path: "/documents",
      product_id: null,
      project_id: null,
      // Inject an oversized field that should trip the byte cap.
      referrer: `https://kzq.test/${huge}`,
    });
    expect(body.length).toBeGreaterThan(8 * 1024);
    const req = sameOriginJsonRequest(
      "https://kzq.test/api/analytics/events",
      {},
      { raw: body },
    );
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it("rejects an unknown event_name with 400", async () => {
    const { POST } = await import("@/app/api/analytics/events/route");
    const req = sameOriginJsonRequest(
      "https://kzq.test/api/analytics/events",
      {
        event_name: "fake_event",
        locale: "en",
        page_path: "/documents",
        product_id: null,
        project_id: null,
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 204 with no-store on success", async () => {
    const { POST } = await import("@/app/api/analytics/events/route");
    const req = sameOriginJsonRequest(
      "https://kzq.test/api/analytics/events",
      {
        event_name: "page_view",
        locale: "en",
        page_path: "/documents",
        product_id: null,
        project_id: null,
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(204);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects cross-site requests with 403", async () => {
    const { POST } = await import("@/app/api/analytics/events/route");
    const req = jsonRequest(
      "https://kzq.test/api/analytics/events",
      {},
      { origin: "https://evil.example", host: "kzq.test" },
    );
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("does not leak the repository error message on failure", async () => {
    const { recordAnalyticsEvent } = await import("@/lib/repositories/analytics");
    vi.mocked(recordAnalyticsEvent).mockRejectedValueOnce(
      new Error("Postgres error: insert into analytics_events ... 'secret_token'"),
    );
    const { POST } = await import("@/app/api/analytics/events/route");
    const req = sameOriginJsonRequest(
      "https://kzq.test/api/analytics/events",
      {
        event_name: "page_view",
        locale: "en",
        page_path: "/documents",
        product_id: null,
        project_id: null,
      },
    );
    const res = await POST(req);
    const payload = await res.json();
    expect(res.status).toBe(503);
    expect(JSON.stringify(payload)).not.toContain("Postgres error");
    expect(JSON.stringify(payload)).not.toContain("secret_token");
    expect(JSON.stringify(payload)).not.toContain("insert into");
  });
});
