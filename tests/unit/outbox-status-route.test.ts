import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockRpc = vi.fn();
const mockClient = { rpc: mockRpc };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: () => mockClient,
}));

const VALID_SECRET = "test-status-secret-0123456789-absolutely-long-enough";

function statusRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://kzq.test/api/internal/outbox/status", {
    method: "GET",
    headers,
  });
}

describe("GET /api/internal/outbox/status — Work Package E health snapshot", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    vi.stubEnv("OUTBOX_DISPATCH_SECRET", VALID_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 503 when OUTBOX_DISPATCH_SECRET is missing (fail-closed)", async () => {
    vi.stubEnv("OUTBOX_DISPATCH_SECRET", "");
    const { GET } = await import("@/app/api/internal/outbox/status/route");
    const response = await GET(
      statusRequest({ Authorization: `Bearer ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(503);
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe("status_disabled");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 503 when secret is too short (<16 chars)", async () => {
    vi.stubEnv("OUTBOX_DISPATCH_SECRET", "short");
    const { GET } = await import("@/app/api/internal/outbox/status/route");
    const response = await GET(
      statusRequest({ Authorization: "Bearer short" }),
    );
    expect(response.status).toBe(503);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { GET } = await import("@/app/api/internal/outbox/status/route");
    const response = await GET(statusRequest());
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error).toBe("missing_or_malformed_authorization");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization is not Bearer scheme", async () => {
    const { GET } = await import("@/app/api/internal/outbox/status/route");
    const response = await GET(
      statusRequest({ Authorization: `Basic ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 403 when token does not match (timing-safe)", async () => {
    const { GET } = await import("@/app/api/internal/outbox/status/route");
    const response = await GET(
      statusRequest({ Authorization: "Bearer wrong-secret-value-here" }),
    );
    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json.error).toBe("forbidden");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 200 with coarse snapshot on success and never exposes PII", async () => {
    const snapshot = {
      pending_count: 3,
      retry_count: 1,
      claimed_count: 2,
      sent_count: 150,
      dead_letter_count: 0,
      cancelled_count: 4,
      oldest_pending_age_seconds: 12.5,
      oldest_claimed_age_seconds: 5.0,
      oldest_dead_letter_age_seconds: null,
      last_sent_at: "2026-07-27T10:00:00Z",
      last_failed_at: null,
      evaluated_at: "2026-07-27T10:01:00Z",
    };
    mockRpc.mockResolvedValue({ data: snapshot, error: null });
    const { GET } = await import("@/app/api/internal/outbox/status/route");
    const response = await GET(
      statusRequest({ Authorization: `Bearer ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(true);
    expect(json.snapshot).toEqual(snapshot);
    // Cache-Control: private, no-store (prevent CDN caching).
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    // Shape check: the response MUST NOT contain inquiry-level PII.
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("inquiry_id");
    expect(serialized).not.toContain("lock_token");
    expect(serialized).not.toContain("provider_message_id");
    expect(serialized).not.toContain("last_error_code");
    expect(serialized).not.toContain("name");
    expect(serialized).not.toContain("phone");
    expect(serialized).not.toContain("email");
  });

  it("returns 200 when RPC returns an array (defensive single-row handling)", async () => {
    // Some Supabase client versions return RPC results as an array.
    // The route must extract the first row.
    const snapshot = {
      pending_count: 0,
      retry_count: 0,
      claimed_count: 0,
      sent_count: 0,
      dead_letter_count: 0,
      cancelled_count: 0,
      oldest_pending_age_seconds: null,
      oldest_claimed_age_seconds: null,
      oldest_dead_letter_age_seconds: null,
      last_sent_at: null,
      last_failed_at: null,
      evaluated_at: "2026-07-27T10:01:00Z",
    };
    mockRpc.mockResolvedValue({ data: [snapshot], error: null });
    const { GET } = await import("@/app/api/internal/outbox/status/route");
    const response = await GET(
      statusRequest({ Authorization: `Bearer ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.snapshot).toEqual(snapshot);
  });

  it("returns 500 with fixed code when RPC fails (no raw error leakage)", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: "select * from inquiry_outbox_deliveries where status = 'PII_TEXT'" },
    });
    const { GET } = await import("@/app/api/internal/outbox/status/route");
    const response = await GET(
      statusRequest({ Authorization: `Bearer ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("snapshot_failed");
    // Never leak raw SQL / Supabase error text.
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("select");
    expect(serialized).not.toContain("inquiry_outbox_deliveries");
    expect(serialized).not.toContain("PII_TEXT");
  });

  it("returns 500 with fixed code when RPC returns empty (defensive)", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const { GET } = await import("@/app/api/internal/outbox/status/route");
    const response = await GET(
      statusRequest({ Authorization: `Bearer ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("snapshot_empty");
  });

  it("returns 500 with fixed code on unexpected exception", async () => {
    mockRpc.mockRejectedValue(new Error("connection reset by peer"));
    const { GET } = await import("@/app/api/internal/outbox/status/route");
    const response = await GET(
      statusRequest({ Authorization: `Bearer ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("snapshot_failed");
    // Never leak the raw exception message.
    expect(JSON.stringify(json)).not.toContain("connection reset");
  });

  it("returns 405 on POST", async () => {
    const { POST } = await import("@/app/api/internal/outbox/status/route");
    const response = POST();
    expect(response.status).toBe(405);
  });
});
