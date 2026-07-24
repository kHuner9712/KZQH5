import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getVerifiedAdmin = vi.fn();
const saveProductViaRpc = vi.fn();
const bulkUpdateProducts = vi.fn();
const bulkDeleteProducts = vi.fn();
const isDemoMode = vi.fn(() => false);
const revalidatePath = vi.fn();

vi.mock("@/lib/services/admin-auth", () => ({ getVerifiedAdmin }));
vi.mock("@/lib/services/admin-product-write", () => ({
  saveProductViaRpc,
  bulkUpdateProducts,
  bulkDeleteProducts,
  validateProductPayload: vi.fn((input: unknown) => {
    // Lightweight stand-in: mirror the real validator's contract for the
    // cases exercised by these route tests.
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, errors: [{ field: "body", reason: "not-object" }] };
    }
    const body = input as Record<string, unknown>;
    if (!body.name_cn || typeof body.name_cn !== "string" || body.name_cn.trim().length === 0) {
      return { ok: false, errors: [{ field: "name_cn", reason: "empty" }] };
    }
    if (!body.slug || typeof body.slug !== "string") {
      return { ok: false, errors: [{ field: "slug", reason: "invalid-slug" }] };
    }
    if (typeof body.is_published !== "boolean") {
      return { ok: false, errors: [{ field: "is_published", reason: "not-boolean" }] };
    }
    if (typeof body.is_featured !== "boolean") {
      return { ok: false, errors: [{ field: "is_featured", reason: "not-boolean" }] };
    }
    if (typeof body.sort_order !== "number") {
      return { ok: false, errors: [{ field: "sort_order", reason: "not-integer" }] };
    }
    return {
      ok: true,
      value: {
        id: body.id ?? null,
        product: body,
        images: Array.isArray(body.images) ? body.images : [],
      },
    };
  }),
}));
vi.mock("@/lib/demo", () => ({ isDemoMode }));
vi.mock("next/cache", () => ({ revalidatePath }));

function jsonRequest(
  url: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {
    "Content-Type": "application/json",
    Host: "kzq.test",
    Origin: "https://kzq.test",
  },
): NextRequest {
  return new NextRequest(url, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

describe("admin product write API (Phase 2)", () => {
  beforeEach(() => {
    getVerifiedAdmin.mockReset();
    saveProductViaRpc.mockReset();
    bulkUpdateProducts.mockReset();
    bulkDeleteProducts.mockReset();
    isDemoMode.mockReturnValue(false);
    revalidatePath.mockReset();
  });

  it("rejects unauthenticated requests", async () => {
    getVerifiedAdmin.mockResolvedValue({ ok: false, reason: "session-missing" });
    const { POST } = await import("@/app/api/admin/products/route");

    const res = await POST(
      jsonRequest("https://kzq.test/api/admin/products", "POST", {
        name_cn: "测试产品",
        slug: "test-product",
        is_published: false,
        is_featured: false,
        sort_order: 0,
      }),
    );

    expect(res.status).toBe(401);
    expect(saveProductViaRpc).not.toHaveBeenCalled();
  });

  it("rejects cross-origin write requests (fail-closed)", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: {},
      user: { id: "u1" },
      profile: { id: "u1", role: "admin" },
    });
    const { POST, PATCH } = await import("@/app/api/admin/products/route");

    const crossOrigin = await POST(
      jsonRequest(
        "https://kzq.test/api/admin/products",
        "POST",
        { name_cn: "x", slug: "x", is_published: false, is_featured: false, sort_order: 0 },
        {
          "Content-Type": "application/json",
          Host: "kzq.test",
          Origin: "https://attacker.example.com",
        },
      ),
    );
    expect(crossOrigin.status).toBe(403);

    // Missing Origin entirely -> also rejected (fail-closed).
    const missingOrigin = await PATCH(
      jsonRequest(
        "https://kzq.test/api/admin/products",
        "PATCH",
        { ids: ["11111111-1111-4111-8111-111111111111"], is_published: true },
        {
          "Content-Type": "application/json",
          Host: "kzq.test",
        },
      ),
    );
    expect(missingOrigin.status).toBe(403);
  });

  it("rejects non-JSON Content-Type", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: {},
      user: { id: "u1" },
      profile: { id: "u1", role: "admin" },
    });
    const { POST } = await import("@/app/api/admin/products/route");

    const res = await POST(
      new NextRequest("https://kzq.test/api/admin/products", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Host: "kzq.test",
          Origin: "https://kzq.test",
        },
        body: "not json",
      }),
    );

    expect(res.status).toBe(415);
  });

  it("rejects invalid payload with 400 and field errors", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: {},
      user: { id: "u1" },
      profile: { id: "u1", role: "admin" },
    });
    const { POST } = await import("@/app/api/admin/products/route");

    const res = await POST(
      jsonRequest("https://kzq.test/api/admin/products", "POST", {
        name_cn: "",
        slug: "test",
        is_published: false,
        is_featured: false,
        sort_order: 0,
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("ADMIN_WRITE_BAD_REQUEST");
    expect(body.fields).toBeDefined();
    expect(saveProductViaRpc).not.toHaveBeenCalled();
  });

  it("returns 409 on slug conflict (unique_violation)", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: {},
      user: { id: "u1" },
      profile: { id: "u1", role: "admin" },
    });
    saveProductViaRpc.mockResolvedValue({ ok: false, code: "ADMIN_WRITE_CONFLICT" });
    const { POST } = await import("@/app/api/admin/products/route");

    const res = await POST(
      jsonRequest("https://kzq.test/api/admin/products", "POST", {
        name_cn: "冲突产品",
        slug: "duplicate-slug",
        is_published: false,
        is_featured: false,
        sort_order: 0,
      }),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("ADMIN_WRITE_CONFLICT");
  });

  it("does NOT return success when the RPC fails", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: {},
      user: { id: "u1" },
      profile: { id: "u1", role: "admin" },
    });
    saveProductViaRpc.mockResolvedValue({ ok: false, code: "ADMIN_WRITE_FAILED" });
    const { POST } = await import("@/app/api/admin/products/route");

    const res = await POST(
      jsonRequest("https://kzq.test/api/admin/products", "POST", {
        name_cn: "失败产品",
        slug: "fail-product",
        is_published: false,
        is_featured: false,
        sort_order: 0,
      }),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("ADMIN_WRITE_FAILED");
    expect(body.id).toBeUndefined();
  });

  it("returns the new id on successful transactional save", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: {},
      user: { id: "u1" },
      profile: { id: "u1", role: "admin" },
    });
    saveProductViaRpc.mockResolvedValue({ ok: true, id: "new-product-id" });
    const { POST } = await import("@/app/api/admin/products/route");

    const res = await POST(
      jsonRequest("https://kzq.test/api/admin/products", "POST", {
        name_cn: "成功产品",
        slug: "success-product",
        is_published: true,
        is_featured: false,
        sort_order: 0,
        images: [{ image_url: "/img/test.jpg", alt_cn: null, alt_en: null, sort_order: 0 }],
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.id).toBe("new-product-id");
    // RPC was called with the images array so the transaction covers them.
    // Phase 13: actor info is passed through (from server-verified session).
    expect(saveProductViaRpc).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        images: expect.arrayContaining([
          expect.objectContaining({ image_url: "/img/test.jpg" }),
        ]),
      }),
      expect.objectContaining({ id: "u1" }),
    );
  });

  it("bulk update rejects non-UUID ids", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: {},
      user: { id: "u1" },
      profile: { id: "u1", role: "admin" },
    });
    const { PATCH } = await import("@/app/api/admin/products/route");

    const res = await PATCH(
      jsonRequest("https://kzq.test/api/admin/products", "PATCH", {
        ids: ["not-a-uuid", "11111111-1111-4111-8111-111111111111"],
        is_published: true,
      }),
    );

    expect(res.status).toBe(400);
    expect(bulkUpdateProducts).not.toHaveBeenCalled();
  });

  it("delete requires a UUID path id", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: {},
      user: { id: "u1" },
      profile: { id: "u1", role: "admin" },
    });
    const { DELETE } = await import("@/app/api/admin/products/[id]/route");

    const res = await DELETE(
      jsonRequest("https://kzq.test/api/admin/products/not-a-uuid", "DELETE", { id: "not-a-uuid" }),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );

    expect(res.status).toBe(400);
    expect(bulkDeleteProducts).not.toHaveBeenCalled();
  });

  it("delete accepts a valid UUID and returns count", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: {},
      user: { id: "u1" },
      profile: { id: "u1", role: "admin" },
    });
    bulkDeleteProducts.mockResolvedValue({ ok: true, count: 1 });
    const { DELETE } = await import("@/app/api/admin/products/[id]/route");

    const res = await DELETE(
      jsonRequest(
        "https://kzq.test/api/admin/products/11111111-1111-4111-8111-111111111111",
        "DELETE",
        {},
      ),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.count).toBe(1);
  });

  // ------------------------------------------------------------
  // Phase 13: RBAC behavior tests (replace structural assertions).
  // These exercise the actual route handler, not just the helper.
  // ------------------------------------------------------------

  it("rejects editor role for product create (RBAC)", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: {},
      user: { id: "u-editor" },
      profile: { id: "u-editor", role: "editor" },
    });
    const { POST } = await import("@/app/api/admin/products/route");

    const res = await POST(
      jsonRequest("https://kzq.test/api/admin/products", "POST", {
        name_cn: "editor 尝试创建",
        slug: "editor-create-attempt",
        is_published: false,
        is_featured: false,
        sort_order: 0,
      }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("ADMIN_WRITE_FORBIDDEN_ROLE");
    expect(saveProductViaRpc).not.toHaveBeenCalled();
  });

  it("rejects editor role for product delete (RBAC)", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: {},
      user: { id: "u-editor" },
      profile: { id: "u-editor", role: "editor" },
    });
    const { DELETE } = await import("@/app/api/admin/products/[id]/route");

    const res = await DELETE(
      jsonRequest(
        "https://kzq.test/api/admin/products/11111111-1111-4111-8111-111111111111",
        "DELETE",
        { id: "11111111-1111-4111-8111-111111111111" },
      ),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) },
    );

    expect(res.status).toBe(403);
    expect(bulkDeleteProducts).not.toHaveBeenCalled();
  });

  it("rejects editor role for bulk publish (RBAC)", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: {},
      user: { id: "u-editor" },
      profile: { id: "u-editor", role: "editor" },
    });
    const { PATCH } = await import("@/app/api/admin/products/route");

    const res = await PATCH(
      jsonRequest("https://kzq.test/api/admin/products", "PATCH", {
        ids: ["11111111-1111-4111-8111-111111111111"],
        is_published: true,
      }),
    );

    expect(res.status).toBe(403);
    expect(bulkUpdateProducts).not.toHaveBeenCalled();
  });

  it("rejects unknown role for product create (RBAC deny-by-default)", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: {},
      user: { id: "u-unknown" },
      profile: { id: "u-unknown", role: "unknown-role" },
    });
    const { POST } = await import("@/app/api/admin/products/route");

    const res = await POST(
      jsonRequest("https://kzq.test/api/admin/products", "POST", {
        name_cn: "unknown role",
        slug: "unknown-role",
        is_published: false,
        is_featured: false,
        sort_order: 0,
      }),
    );

    expect(res.status).toBe(403);
    expect(saveProductViaRpc).not.toHaveBeenCalled();
  });

  it("rejects null role for product create (RBAC deny-by-default)", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: {},
      user: { id: "u-null" },
      profile: { id: "u-null", role: null },
    });
    const { POST } = await import("@/app/api/admin/products/route");

    const res = await POST(
      jsonRequest("https://kzq.test/api/admin/products", "POST", {
        name_cn: "null role",
        slug: "null-role",
        is_published: false,
        is_featured: false,
        sort_order: 0,
      }),
    );

    expect(res.status).toBe(403);
    expect(saveProductViaRpc).not.toHaveBeenCalled();
  });

  it("allows admin role for product create (RBAC)", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: {},
      user: { id: "u-admin" },
      profile: { id: "u-admin", role: "admin" },
    });
    saveProductViaRpc.mockResolvedValue({ ok: true, id: "new-id" });
    const { POST } = await import("@/app/api/admin/products/route");

    const res = await POST(
      jsonRequest("https://kzq.test/api/admin/products", "POST", {
        name_cn: "admin 创建",
        slug: "admin-create",
        is_published: false,
        is_featured: false,
        sort_order: 0,
      }),
    );

    expect(res.status).toBe(200);
    expect(saveProductViaRpc).toHaveBeenCalled();
  });

  it("allows super_admin role for product create (RBAC)", async () => {
    getVerifiedAdmin.mockResolvedValue({
      ok: true,
      client: {},
      user: { id: "u-super" },
      profile: { id: "u-super", role: "super_admin" },
    });
    saveProductViaRpc.mockResolvedValue({ ok: true, id: "new-id" });
    const { POST } = await import("@/app/api/admin/products/route");

    const res = await POST(
      jsonRequest("https://kzq.test/api/admin/products", "POST", {
        name_cn: "super_admin 创建",
        slug: "super-admin-create",
        is_published: false,
        is_featured: false,
        sort_order: 0,
      }),
    );

    expect(res.status).toBe(200);
    expect(saveProductViaRpc).toHaveBeenCalled();
  });
});
