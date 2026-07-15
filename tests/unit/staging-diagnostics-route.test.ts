import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const runStagingDiagnostics = vi.fn();

vi.mock("@/lib/services/staging-diagnostics", () => ({
  runStagingDiagnostics,
}));

function request(token?: string) {
  return new NextRequest("https://staging.example/api/staging/diagnostics", {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
}

const successResult = {
  success: true,
  checks: {
    products: { ok: true, latencyMs: 10 },
    searchRpc: { ok: true, latencyMs: 11 },
    certificates: { ok: true, latencyMs: 12 },
    projects: { ok: true, latencyMs: 13 },
    storage: { ok: true, latencyMs: 14 },
  },
  totalLatencyMs: 20,
};

describe("staging diagnostics route", () => {
  beforeEach(() => {
    vi.stubEnv("STAGING_DIAGNOSTICS_ENABLED", "true");
    vi.stubEnv("STAGING_DIAGNOSTICS_TOKEN", "test-secret");
    runStagingDiagnostics.mockReset();
    runStagingDiagnostics.mockResolvedValue(successResult);
  });

  it("returns 404 while disabled", async () => {
    vi.stubEnv("STAGING_DIAGNOSTICS_ENABLED", "false");
    const { GET } = await import("@/app/api/staging/diagnostics/route");
    const response = await GET(request("test-secret"));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(runStagingDiagnostics).not.toHaveBeenCalled();
  });

  it.each([undefined, "wrong-secret"])(
    "rejects a missing or invalid token (%s)",
    async (token) => {
      const { GET } = await import("@/app/api/staging/diagnostics/route");
      const response = await GET(request(token));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        success: false,
        error: "Unauthorized",
      });
      expect(runStagingDiagnostics).not.toHaveBeenCalled();
    },
  );

  it("returns safe aggregate checks for a correct token", async () => {
    const { GET } = await import("@/app/api/staging/diagnostics/route");
    const response = await GET(request("test-secret"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(successResult);
  });

  it("reports partial dependency failure without exception details", async () => {
    runStagingDiagnostics.mockResolvedValue({
      ...successResult,
      success: false,
      checks: {
        ...successResult.checks,
        projects: { ok: false, latencyMs: 17 },
      },
    });
    const { GET } = await import("@/app/api/staging/diagnostics/route");
    const response = await GET(request("test-secret"));
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.checks.projects).toEqual({ ok: false, latencyMs: 17 });
    expect(JSON.stringify(body)).not.toMatch(/stack|sql|exception|secret/i);
  });
});
