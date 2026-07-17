import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getVerifiedAdmin = vi.fn();
const updateInquiry = vi.fn();

vi.mock("@/lib/services/admin-auth", () => ({ getVerifiedAdmin }));
vi.mock("@/lib/repositories/inquiries", () => ({
  listInquiries: vi.fn(),
  updateInquiry,
}));

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
    updateInquiry.mockReset();
  });

  it("rejects an authenticated non-admin for reads and writes", async () => {
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
        }),
      ),
    );

    expect(getResponse.status).toBe(401);
    expect(patchResponse.status).toBe(401);
    expect(updateInquiry).not.toHaveBeenCalled();
  });

  it("requires same-origin JSON requests", async () => {
    getVerifiedAdmin.mockResolvedValue({ ok: true, client: {}, user: {}, profile: {} });
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
    getVerifiedAdmin.mockResolvedValue({ ok: true, client: {}, user: {}, profile: {} });
    const { PATCH } = await import("@/app/api/admin/inquiries/route");

    const invalidId = await PATCH(
      patchRequest(JSON.stringify({ id: "not-a-uuid", is_read: true })),
    );
    const emptyUpdate = await PATCH(
      patchRequest(
        JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }),
      ),
    );

    expect(invalidId.status).toBe(400);
    expect(emptyUpdate.status).toBe(400);
    expect(updateInquiry).not.toHaveBeenCalled();
  });
});
