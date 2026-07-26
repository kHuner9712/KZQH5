import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getVerifiedAdmin = vi.fn();
const listInquiries = vi.fn();
const isDemoMode = vi.fn(() => false);
const revalidatePath = vi.fn();

vi.mock("@/lib/services/admin-auth", () => ({ getVerifiedAdmin }));
vi.mock("@/lib/repositories/inquiries", () => ({
  listInquiries,
  // updateInquiry is no longer called by the route — it uses the
  // update_inquiry_with_audit RPC via guard.client.rpc. Kept here only
  // to satisfy any other modules that import it.
  updateInquiry: vi.fn(),
}));
vi.mock("@/lib/demo", () => ({ isDemoMode }));
vi.mock("next/cache", () => ({ revalidatePath }));

function patchRequest(
  body: string,
  headers: Record<string, string> = {
    "Content-Type": "application/json",
    Host: "kzq.test",
    Origin: "https://kzq.test",
  },
): NextRequest {
  return new NextRequest("https://kzq.test/api/admin/inquiries", {
    method: "PATCH",
    headers,
    body,
  });
}

describe("admin inquiry API", () => {
  beforeEach(() => {
    getVerifiedAdmin.mockReset();
    listInquiries.mockReset();
    isDemoMode.mockReturnValue(false);
    revalidatePath.mockReset();
  });

  it("rejects an unauthenticated request for reads and writes", async () => {
    getVerifiedAdmin.mockResolvedValue({ ok: false, reason: "session-missing" });
    const { GET, PATCH } = await import("@/app/api/admin/inquiries/route");

    const getResponse = await GET(
      new NextRequest("https://kzq.test/api/admin/inquiries"),
    );
    const patchResponse = await PATCH(
      patchRequest(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          is_read: true,
          expected_updated_at: "2026-07-24T00:00:00.000Z",
        }),
      ),
    );

    expect(getResponse.status).toBe(401);
    expect(patchResponse.status).toBe(401);
    expect(listInquiries).not.toHaveBeenCalled();
  });

  it("requires same-origin JSON requests", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: { rpc: vi.fn() },
      user: { id: "u1" },
      profile: { id: "u1", role: "admin" },
    });
    const { PATCH } = await import("@/app/api/admin/inquiries/route");

    const crossOrigin = await PATCH(
      patchRequest("{}", {
        "Content-Type": "application/json",
        Host: "kzq.test",
        Origin: "https://attacker.test",
      }),
    );
    const wrongType = await PATCH(
      patchRequest("{}", {
        "Content-Type": "text/plain",
        Host: "kzq.test",
        Origin: "https://kzq.test",
      }),
    );

    expect(crossOrigin.status).toBe(403);
    expect(wrongType.status).toBe(415);
  });

  it("rejects invalid IDs and empty updates", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: { rpc: vi.fn() },
      user: { id: "u1" },
      profile: { id: "u1", role: "admin" },
    });
    const { PATCH } = await import("@/app/api/admin/inquiries/route");

    const invalidId = await PATCH(
      patchRequest(JSON.stringify({ id: "not-a-uuid", is_read: true })),
    );
    const emptyUpdate = await PATCH(
      patchRequest(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          expected_updated_at: "2026-07-24T00:00:00.000Z",
        }),
      ),
    );

    expect(invalidId.status).toBe(400);
    expect(emptyUpdate.status).toBe(400);
  });

  // ------------------------------------------------------------
  // Phase 13: Origin fail-closed behavior tests (real route).
  // ------------------------------------------------------------

  it("rejects missing Origin with 403 (fail-closed)", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: { rpc: vi.fn() },
      user: { id: "u1" },
      profile: { id: "u1", role: "admin" },
    });
    const { PATCH } = await import("@/app/api/admin/inquiries/route");

    const res = await PATCH(
      patchRequest(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          is_read: true,
          expected_updated_at: "2026-07-24T00:00:00.000Z",
        }),
        {
          "Content-Type": "application/json",
          Host: "kzq.test",
          // Origin intentionally omitted
        },
      ),
    );

    expect(res.status).toBe(403);
  });

  it("rejects cross-origin with 403", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: { rpc: vi.fn() },
      user: { id: "u1" },
      profile: { id: "u1", role: "admin" },
    });
    const { PATCH } = await import("@/app/api/admin/inquiries/route");

    const res = await PATCH(
      patchRequest(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          is_read: true,
          expected_updated_at: "2026-07-24T00:00:00.000Z",
        }),
        {
          "Content-Type": "application/json",
          Host: "kzq.test",
          Origin: "https://attacker.example.com",
        },
      ),
    );

    expect(res.status).toBe(403);
  });

  it("rejects same-site different subdomain with 403", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: { rpc: vi.fn() },
      user: { id: "u1" },
      profile: { id: "u1", role: "admin" },
    });
    const { PATCH } = await import("@/app/api/admin/inquiries/route");

    const res = await PATCH(
      patchRequest(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          is_read: true,
          expected_updated_at: "2026-07-24T00:00:00.000Z",
        }),
        {
          "Content-Type": "application/json",
          Host: "kzq.test",
          Origin: "https://shop.kzq.test",
          "Sec-Fetch-Site": "same-site",
        },
      ),
    );

    expect(res.status).toBe(403);
  });

  // ------------------------------------------------------------
  // Phase 13: optimistic lock requirement (expected_updated_at).
  // ------------------------------------------------------------

  it("rejects PATCH without expected_updated_at (optimistic lock required)", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: { rpc: vi.fn() },
      user: { id: "u1" },
      profile: { id: "u1", role: "admin" },
    });
    const { PATCH } = await import("@/app/api/admin/inquiries/route");

    const res = await PATCH(
      patchRequest(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          is_read: true,
        }),
      ),
    );

    expect(res.status).toBe(400);
  });

  // ------------------------------------------------------------
  // Phase 13: RBAC behavior tests (editor denied).
  // ------------------------------------------------------------

  it("rejects editor role for inquiry PATCH (RBAC)", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: { rpc: vi.fn() },
      user: { id: "u-editor" },
      profile: { id: "u-editor", role: "editor" },
    });
    const { PATCH } = await import("@/app/api/admin/inquiries/route");

    const res = await PATCH(
      patchRequest(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          is_read: true,
          expected_updated_at: "2026-07-24T00:00:00.000Z",
        }),
      ),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("ADMIN_WRITE_FORBIDDEN_ROLE");
  });

  it("allows admin role for inquiry PATCH and forwards to RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { id: "11111111-1111-4111-8111-111111111111", is_read: true },
      error: null,
    });
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: { rpc },
      user: { id: "u-admin", email: "admin@kzq.test" },
      profile: { id: "u-admin", role: "admin" },
    });
    const { PATCH } = await import("@/app/api/admin/inquiries/route");

    const res = await PATCH(
      patchRequest(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          is_read: true,
          expected_updated_at: "2026-07-24T00:00:00.000Z",
        }),
      ),
    );

    expect(res.status).toBe(200);
    // Phase 13: RPC was called with actor info from server-verified session.
    expect(rpc).toHaveBeenCalledWith(
      "update_inquiry_with_audit",
      expect.objectContaining({
        p_id: "11111111-1111-4111-8111-111111111111",
        p_actor_id: "u-admin",
        p_actor_email: "admin@kzq.test",
        p_actor_role: "admin",
        p_expected_updated_at: "2026-07-24T00:00:00.000Z",
      }),
    );
  });

  it("returns 409 when RPC reports optimistic lock conflict", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "40P01" },
    });
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: { rpc },
      user: { id: "u-admin" },
      profile: { id: "u-admin", role: "admin" },
    });
    const { PATCH } = await import("@/app/api/admin/inquiries/route");

    const res = await PATCH(
      patchRequest(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          is_read: true,
          expected_updated_at: "2026-07-24T00:00:00.000Z",
        }),
      ),
    );

    expect(res.status).toBe(409);
  });
});
