import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Mock reconcilePendingStorageAudit so the route test focuses on
// authentication, body validation, and response formatting. The
// underlying claim/reconcile logic is exercised in the storage-upload
// reconcile tests, not here.
const mockReconcile = vi.fn();

vi.mock("@/lib/services/storage-upload", () => ({
  reconcilePendingStorageAudit: (options: unknown) => mockReconcile(options),
}));

const VALID_SECRET = "test-maintenance-secret-0123456789-long-enough";

function reconcileRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(
    "https://kzq.test/api/internal/storage/audit-reconcile",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
    },
  );
}

describe("POST /api/internal/storage/audit-reconcile — fail-closed reconcile entrypoint", () => {
  beforeEach(() => {
    mockReconcile.mockReset();
    vi.stubEnv("STORAGE_MAINTENANCE_SECRET", VALID_SECRET);
    vi.stubEnv("OUTBOX_DISPATCH_SECRET", "different-outbox-secret-0123456789");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 503 when STORAGE_MAINTENANCE_SECRET is missing (fail-closed)", async () => {
    vi.stubEnv("STORAGE_MAINTENANCE_SECRET", "");
    const { POST } = await import(
      "@/app/api/internal/storage/audit-reconcile/route"
    );
    const response = await POST(
      reconcileRequest({}, { Authorization: `Bearer ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(503);
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe("reconcile_disabled");
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("returns 503 when secret is too short (<16 chars)", async () => {
    vi.stubEnv("STORAGE_MAINTENANCE_SECRET", "short");
    const { POST } = await import(
      "@/app/api/internal/storage/audit-reconcile/route"
    );
    const response = await POST(
      reconcileRequest({}, { Authorization: "Bearer short" }),
    );
    expect(response.status).toBe(503);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { POST } = await import(
      "@/app/api/internal/storage/audit-reconcile/route"
    );
    const response = await POST(reconcileRequest({}));
    expect(response.status).toBe(401);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is not Bearer scheme", async () => {
    const { POST } = await import(
      "@/app/api/internal/storage/audit-reconcile/route"
    );
    const response = await POST(
      reconcileRequest({}, { Authorization: `Basic ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(401);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("returns 403 when Bearer token does not match (timing-safe)", async () => {
    const { POST } = await import(
      "@/app/api/internal/storage/audit-reconcile/route"
    );
    const response = await POST(
      reconcileRequest({}, { Authorization: "Bearer wrong-secret-value-here" }),
    );
    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe("forbidden");
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("returns 415 when Content-Type is not application/json", async () => {
    const { POST } = await import(
      "@/app/api/internal/storage/audit-reconcile/route"
    );
    const req = new NextRequest(
      "https://kzq.test/api/internal/storage/audit-reconcile",
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Authorization: `Bearer ${VALID_SECRET}`,
        },
        body: "not-json",
      },
    );
    const response = await POST(req);
    expect(response.status).toBe(415);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("returns 400 when JSON body is malformed", async () => {
    const { POST } = await import(
      "@/app/api/internal/storage/audit-reconcile/route"
    );
    const req = new NextRequest(
      "https://kzq.test/api/internal/storage/audit-reconcile",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VALID_SECRET}`,
        },
        body: "{not valid json",
      },
    );
    const response = await POST(req);
    expect(response.status).toBe(400);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("returns 200 with coarse counters when reconcile succeeds", async () => {
    mockReconcile.mockResolvedValue({
      ok: true,
      processed: 5,
      completed: 4,
      failed: 1,
    });
    const { POST } = await import(
      "@/app/api/internal/storage/audit-reconcile/route"
    );
    const response = await POST(
      reconcileRequest(
        { minAgeSeconds: 600, limit: 25, staleTimeoutSeconds: 120 },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(true);
    expect(json.result).toEqual({
      processed: 5,
      completed: 4,
      failed: 1,
    });
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    const call = mockReconcile.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.minAgeSeconds).toBe(600);
    expect(call.limit).toBe(25);
    expect(call.staleTimeoutSeconds).toBe(120);
  });

  it("returns 200 when no pending rows need reconcile (processed=0)", async () => {
    mockReconcile.mockResolvedValue({
      ok: true,
      processed: 0,
      completed: 0,
      failed: 0,
    });
    const { POST } = await import(
      "@/app/api/internal/storage/audit-reconcile/route"
    );
    const response = await POST(
      reconcileRequest({}, { Authorization: `Bearer ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(true);
    expect(json.result).toEqual({
      processed: 0,
      completed: 0,
      failed: 0,
    });
  });

  it("returns 500 when reconcile returns structured failure (no internal code leaked)", async () => {
    mockReconcile.mockResolvedValue({ ok: false, code: "ADMIN_WRITE_FAILED" });
    const { POST } = await import(
      "@/app/api/internal/storage/audit-reconcile/route"
    );
    const response = await POST(
      reconcileRequest({}, { Authorization: `Bearer ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.ok).toBe(false);
    // The internal ADMIN_WRITE_FAILED code MUST NOT be echoed.
    expect(json.error).toBe("reconcile_failed");
  });

  it("clamps invalid body parameters to safe defaults", async () => {
    mockReconcile.mockResolvedValue({
      ok: true,
      processed: 0,
      completed: 0,
      failed: 0,
    });
    const { POST } = await import(
      "@/app/api/internal/storage/audit-reconcile/route"
    );
    await POST(
      reconcileRequest(
        {
          minAgeSeconds: -5, // below minimum → clamped to 60
          limit: 9999, // above maximum → clamped to 200
          staleTimeoutSeconds: "not-a-number", // non-number → default 300
        },
        { Authorization: `Bearer ${VALID_SECRET}` },
      ),
    );
    const call = mockReconcile.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.minAgeSeconds).toBe(60);
    expect(call.limit).toBe(200);
    expect(call.staleTimeoutSeconds).toBe(300);
  });

  it("rejects GET method", async () => {
    const { GET } = await import(
      "@/app/api/internal/storage/audit-reconcile/route"
    );
    const response = await GET();
    expect(response.status).toBe(405);
  });

  it("does not leak internal error code on reconcile exception", async () => {
    mockReconcile.mockRejectedValue(new Error("database connection lost"));
    const { POST } = await import(
      "@/app/api/internal/storage/audit-reconcile/route"
    );
    const response = await POST(
      reconcileRequest({}, { Authorization: `Bearer ${VALID_SECRET}` }),
    );
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("reconcile_failed");
    // The internal exception message MUST NOT appear in the response.
    expect(JSON.stringify(json)).not.toContain("database connection lost");
  });
});
