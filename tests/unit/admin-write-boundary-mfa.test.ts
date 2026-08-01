import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getVerifiedAdmin = vi.fn();
vi.mock("@/lib/services/admin-auth", () => ({ getVerifiedAdmin }));

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

describe("KZQ-P1-022-e: step-up error code on admin API boundary", () => {
  beforeEach(() => {
    getVerifiedAdmin.mockReset();
  });

  it("requireAdminWrite returns 401 ADMIN_WRITE_MFA_REQUIRED for an aal-insufficient session", async () => {
    const { requireAdminWrite } = await import(
      "@/lib/services/admin-write-boundary"
    );
    getVerifiedAdmin.mockResolvedValue({ ok: false, reason: "aal-insufficient" });

    const result = await requireAdminWrite(makeRequest(), {
      maxBytes: 1024,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = (await result.response.json()) as { error?: string };
      expect(body.error).toBe("ADMIN_WRITE_MFA_REQUIRED");
    }
  });

  it("requireAdminRead returns 401 ADMIN_WRITE_MFA_REQUIRED for an aal-insufficient session", async () => {
    const { requireAdminRead } = await import(
      "@/lib/services/admin-write-boundary"
    );
    getVerifiedAdmin.mockResolvedValue({ ok: false, reason: "aal-insufficient" });

    const result = await requireAdminRead(makeRequest());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = (await result.response.json()) as { error?: string };
      expect(body.error).toBe("ADMIN_WRITE_MFA_REQUIRED");
    }
  });

  it("requireAdminWrite keeps ADMIN_WRITE_UNAUTHORIZED for a session-missing session", async () => {
    const { requireAdminWrite } = await import(
      "@/lib/services/admin-write-boundary"
    );
    getVerifiedAdmin.mockResolvedValue({ ok: false, reason: "session-missing" });

    const result = await requireAdminWrite(makeRequest(), {
      maxBytes: 1024,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = (await result.response.json()) as { error?: string };
      expect(body.error).toBe("ADMIN_WRITE_UNAUTHORIZED");
    }
  });

  it("requireAdminRead keeps ADMIN_WRITE_UNAUTHORIZED for a session-missing session", async () => {
    const { requireAdminRead } = await import(
      "@/lib/services/admin-write-boundary"
    );
    getVerifiedAdmin.mockResolvedValue({ ok: false, reason: "session-missing" });

    const result = await requireAdminRead(makeRequest());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = (await result.response.json()) as { error?: string };
      expect(body.error).toBe("ADMIN_WRITE_UNAUTHORIZED");
    }
  });
});
