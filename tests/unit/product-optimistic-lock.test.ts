// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Mock global fetch — adminFetch internally calls fetch(url, ...),
// so mocking fetch captures the request body that saveProduct builds.
const fetchMock = vi.fn();

afterEach(() => {
  fetchMock.mockReset();
});

/**
 * Static regression: ProductForm MUST pass `expected_updated_at` when
 * editing an existing product. The server RPC rejects updates without
 * it (400) or with a stale value (409). A previous version of the
 * form omitted the field entirely, making every edit a 400 failure.
 */
describe("ProductForm optimistic lock — static regression", () => {
  it("ProductForm.tsx passes expected_updated_at from initial.updated_at", () => {
    const source = readFileSync(
      join(process.cwd(), "components/admin/ProductForm.tsx"),
      "utf8",
    );
    // The form must read initial.updated_at and pass it through.
    expect(source).toContain("expected_updated_at");
    expect(source).toContain("initial?.updated_at");
  });

  it("saveProduct type signature includes expected_updated_at", () => {
    const source = readFileSync(
      join(process.cwd(), "lib/services/admin-fetch.ts"),
      "utf8",
    );
    expect(source).toMatch(/expected_updated_at\?:\s*string\s*\|\s*null/);
  });

  it("inquiry detail panel passes expected_updated_at from inquiry.updated_at", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "app/admin/(protected)/inquiries/page.tsx",
      ),
      "utf8",
    );
    expect(source).toContain("expected_updated_at");
    expect(source).toContain("inquiry.updated_at");
  });
});

/**
 * Runtime regression: calling saveProduct with expected_updated_at
 * forwards it to adminFetch so the server RPC can compare it against
 * products.updated_at (FOR UPDATE). The server returns 409 when stale.
 */
describe("saveProduct forwards expected_updated_at to adminFetch", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // adminFetch calls fetch(url, { method, body: JSON.stringify(payload) })
    // and parses the response. We mock a successful response.
    fetchMock.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ success: true, id: "p-1" })),
    });
    // Stub global fetch so adminFetch's internal fetch() call is captured.
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("update path includes expected_updated_at in the payload", async () => {
    const { saveProduct } = await import("@/lib/services/admin-fetch");
    await saveProduct({
      id: "p-1",
      product: { name_cn: "Board" },
      images: [],
      expected_updated_at: "2026-07-25T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/products");
    expect(init.method).toBe("POST");
    const payload = JSON.parse(init.body);
    expect(payload).toMatchObject({
      id: "p-1",
      expected_updated_at: "2026-07-25T00:00:00.000Z",
    });
  });

  it("create path may omit expected_updated_at", async () => {
    const { saveProduct } = await import("@/lib/services/admin-fetch");
    await saveProduct({
      product: { name_cn: "New Board" },
      images: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const payload = JSON.parse(init.body);
    expect(payload.expected_updated_at).toBeUndefined();
  });
});

/**
 * Server-side contract: the validateProductPayload helper enforces
 * expected_updated_at on updates (missing → 400, invalid → 400). The
 * RPC throws 40P01 on stale stamps which the route maps to 409.
 * These tests live in admin-product-write.test.ts and
 * transaction-optimistic-lock-audit.test.ts; here we only assert the
 * static contract is unchanged.
 */
describe("optimistic lock server-side contract — static presence", () => {
  it("admin-product-write.ts enforces expected_updated_at on update", () => {
    const source = readFileSync(
      join(process.cwd(), "lib/services/admin-product-write.ts"),
      "utf8",
    );
    expect(source).toContain("required-for-update");
    expect(source).toContain("expected_updated_at");
  });

  it("admin-inquiries route requires expected_updated_at on PATCH", () => {
    const source = readFileSync(
      join(process.cwd(), "app/api/admin/inquiries/route.ts"),
      "utf8",
    );
    expect(source).toContain("expected_updated_at");
    expect(source).toContain("为必填字段");
  });
});
