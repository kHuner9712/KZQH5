import { describe, expect, it, vi } from "vitest";
import type { AdminDashboardQueries } from "@/lib/repositories/admin-dashboard";
import {
  DashboardSnapshotError,
  parseDashboardSnapshot,
} from "@/lib/repositories/admin-dashboard";
import { loadAdminDashboard } from "@/lib/services/admin-dashboard";
import type { Inquiry } from "@/types/database";

const realInquiry = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "[REGRESSION TEST] dashboard",
  status: "new",
  is_read: false,
  interested_product: null,
  message: null,
  created_at: "2026-07-16T00:00:00.000Z",
  country: null,
} as Inquiry;

function snapshot(
  overrides: Partial<{
    totalProducts: number;
    publishedProducts: number;
    totalCertificates: number;
    totalInquiries: number;
    unreadInquiries: number;
  }> = {},
) {
  return {
    totalProducts: 3,
    publishedProducts: 2,
    totalCertificates: 1,
    totalInquiries: 2,
    unreadInquiries: 1,
    ...overrides,
  };
}

function makeQueries(
  overrides: Partial<AdminDashboardQueries> = {},
): AdminDashboardQueries {
  return {
    getSnapshot: vi.fn().mockResolvedValue(snapshot()),
    recentInquiries: vi.fn().mockResolvedValue([realInquiry]),
    ...overrides,
  };
}

describe("admin dashboard integrity", () => {
  it("does not substitute mock inquiries outside Demo mode", async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "false";
    const queries = makeQueries();

    const result = await loadAdminDashboard(queries);

    expect(result).toMatchObject({
      ok: true,
      data: { recentInquiries: [{ id: realInquiry.id }] },
    });
    expect(queries.recentInquiries).toHaveBeenCalledOnce();
  });

  it("keeps a two-row inquiry total consistent with the recent list", async () => {
    const result = await loadAdminDashboard(
      makeQueries({
        getSnapshot: vi.fn().mockResolvedValue(snapshot({ totalInquiries: 2 })),
        recentInquiries: vi.fn().mockResolvedValue([
          realInquiry,
          { ...realInquiry, id: "22222222-2222-4222-8222-222222222222" },
        ]),
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      data: { inquiryCount: 2, recentInquiries: [{}, {}] },
    });
  });

  it("returns an explicit error state instead of zero on snapshot failure", async () => {
    const log = vi.fn();
    const result = await loadAdminDashboard(
      makeQueries({
        getSnapshot: vi
          .fn()
          .mockRejectedValue(new DashboardSnapshotError("permission")),
      }),
      log,
    );

    expect(result).toEqual({ ok: false });
    expect(log).toHaveBeenCalledWith("Admin dashboard data read failed", {
      queries: ["dashboard.snapshot:permission"],
    });
  });

  it("returns an explicit error state when recent inquiries fail", async () => {
    const log = vi.fn();
    const result = await loadAdminDashboard(
      makeQueries({
        recentInquiries: vi
          .fn()
          .mockRejectedValue(new DashboardSnapshotError("count-unavailable")),
      }),
      log,
    );

    expect(result).toEqual({ ok: false });
    expect(log).toHaveBeenCalledWith("Admin dashboard data read failed", {
      queries: ["inquiries.recent:count-unavailable"],
    });
  });

  it("shows real zeros for empty tables", async () => {
    const result = await loadAdminDashboard(
      makeQueries({
        getSnapshot: vi.fn().mockResolvedValue(
          snapshot({
            totalProducts: 0,
            publishedProducts: 0,
            totalCertificates: 0,
            totalInquiries: 0,
            unreadInquiries: 0,
          }),
        ),
        recentInquiries: vi.fn().mockResolvedValue([]),
      }),
    );

    expect(result).toEqual({
      ok: true,
      data: {
        productCount: 0,
        publishedCount: 0,
        certificateCount: 0,
        inquiryCount: 0,
        unreadCount: 0,
        recentInquiries: [],
      },
    });
  });

  it("uses the exact unread inquiry count", async () => {
    const result = await loadAdminDashboard(
      makeQueries({
        getSnapshot: vi.fn().mockResolvedValue(snapshot({ unreadInquiries: 2 })),
      }),
    );
    expect(result).toMatchObject({ ok: true, data: { unreadCount: 2 } });
  });

  it("reflects a product publish-state change on the next read", async () => {
    const getSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot({ publishedProducts: 2 }))
      .mockResolvedValueOnce(snapshot({ publishedProducts: 1 }));
    const queries = makeQueries({ getSnapshot });

    const before = await loadAdminDashboard(queries);
    const after = await loadAdminDashboard(queries);

    expect(before).toMatchObject({ ok: true, data: { publishedCount: 2 } });
    expect(after).toMatchObject({ ok: true, data: { publishedCount: 1 } });
  });

  it("reflects certificate additions and deletions on subsequent reads", async () => {
    const getSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot({ totalCertificates: 1 }))
      .mockResolvedValueOnce(snapshot({ totalCertificates: 2 }))
      .mockResolvedValueOnce(snapshot({ totalCertificates: 1 }));
    const queries = makeQueries({ getSnapshot });

    const before = await loadAdminDashboard(queries);
    const added = await loadAdminDashboard(queries);
    const deleted = await loadAdminDashboard(queries);

    expect(before).toMatchObject({ ok: true, data: { certificateCount: 1 } });
    expect(added).toMatchObject({ ok: true, data: { certificateCount: 2 } });
    expect(deleted).toMatchObject({ ok: true, data: { certificateCount: 1 } });
  });

  it("does not expose database exception text in logs or the result", async () => {
    const log = vi.fn();
    const sensitiveMessage = "relation secret_table failed with private details";
    const result = await loadAdminDashboard(
      makeQueries({
        getSnapshot: vi.fn().mockRejectedValue(new Error(sensitiveMessage)),
      }),
      log,
    );

    expect(JSON.stringify(result)).not.toContain(sensitiveMessage);
    expect(JSON.stringify(log.mock.calls)).not.toContain(sensitiveMessage);
    expect(log).toHaveBeenCalledWith("Admin dashboard data read failed", {
      queries: ["dashboard.snapshot:unknown"],
    });
  });

  it("does NOT return 0 on failure (no deny-by-default regression)", async () => {
    const queries = makeQueries({
      getSnapshot: vi
        .fn()
        .mockRejectedValue(new DashboardSnapshotError("permission")),
    });
    const result = await loadAdminDashboard(queries);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure state, got success");
    }
  });
});

describe("parseDashboardSnapshot (RPC structural validation)", () => {
  const validObject = {
    total_products: 3,
    published_products: 2,
    total_certificates: 1,
    total_inquiries: 2,
    unread_inquiries: 1,
  };

  it("accepts a well-formed object with numeric counts", () => {
    expect(parseDashboardSnapshot(validObject)).toEqual({
      totalProducts: 3,
      publishedProducts: 2,
      totalCertificates: 1,
      totalInquiries: 2,
      unreadInquiries: 1,
    });
  });

  it("accepts decimal-string counts that convert to safe integers", () => {
    expect(
      parseDashboardSnapshot({
        total_products: "3",
        published_products: "2",
        total_certificates: "1",
        total_inquiries: "2",
        unread_inquiries: "1",
      }),
    ).toEqual({
      totalProducts: 3,
      publishedProducts: 2,
      totalCertificates: 1,
      totalInquiries: 2,
      unreadInquiries: 1,
    });
  });

  it("accepts a mixed numeric/string payload (PostgREST may stringify bigints)", () => {
    expect(
      parseDashboardSnapshot({
        total_products: "3",
        published_products: 2,
        total_certificates: "1",
        total_inquiries: 2,
        unread_inquiries: "1",
      }),
    ).toEqual({
      totalProducts: 3,
      publishedProducts: 2,
      totalCertificates: 1,
      totalInquiries: 2,
      unreadInquiries: 1,
    });
  });

  it("accepts an array with exactly one row (table return shape)", () => {
    expect(parseDashboardSnapshot([validObject])).toEqual({
      totalProducts: 3,
      publishedProducts: 2,
      totalCertificates: 1,
      totalInquiries: 2,
      unreadInquiries: 1,
    });
  });

  it("accepts real zeros", () => {
    expect(
      parseDashboardSnapshot({
        total_products: 0,
        published_products: 0,
        total_certificates: 0,
        total_inquiries: 0,
        unread_inquiries: 0,
      }),
    ).toEqual({
      totalProducts: 0,
      publishedProducts: 0,
      totalCertificates: 0,
      totalInquiries: 0,
      unreadInquiries: 0,
    });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 5],
    ["a string", "5"],
    ["a boolean", true],
    ["an empty array", []],
    ["an array with two rows", [validObject, validObject]],
    ["an object missing all fields", {}],
  ])("rejects %s as count-unavailable", (_label, data) => {
    expect(() => parseDashboardSnapshot(data)).toThrowError(
      DashboardSnapshotError,
    );
    try {
      parseDashboardSnapshot(data);
    } catch (err) {
      expect((err as DashboardSnapshotError).causeCode).toBe(
        "count-unavailable",
      );
    }
  });

  it.each([
    ["total_products missing", { ...validObject, total_products: undefined }],
    ["published_products missing", { ...validObject, published_products: undefined }],
    ["total_certificates missing", { ...validObject, total_certificates: undefined }],
    ["total_inquiries missing", { ...validObject, total_inquiries: undefined }],
    ["unread_inquiries missing", { ...validObject, unread_inquiries: undefined }],
  ])("rejects when %s", (_label, data) => {
    expect(() => parseDashboardSnapshot(data)).toThrowError(
      DashboardSnapshotError,
    );
  });

  it.each([
    ["negative number", -1],
    ["fractional number", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["number above MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 1],
    ["empty string", ""],
    ["negative string", "-1"],
    ["positive-signed string", "+1"],
    ["decimal string", "1.0"],
    ["scientific-notation string", "1e3"],
    ["string above MAX_SAFE_INTEGER", "9007199254740992"],
    ["object", { count: 1 }],
    ["array", [1]],
    ["boolean", true],
    ["null", null],
  ])("rejects an invalid count value: %s", (label, value) => {
    expect(() =>
      parseDashboardSnapshot({ ...validObject, total_products: value }),
    ).toThrowError(DashboardSnapshotError);
  });

  it("never returns a synthetic zero when a field is structurally invalid", () => {
    const outcomes: number[] = [];
    try {
      outcomes.push(
        parseDashboardSnapshot({ ...validObject, total_inquiries: -1 })
          .totalInquiries,
      );
    } catch {
      // expected
    }
    expect(outcomes).not.toContain(0);
  });
});

describe("DashboardSnapshotError", () => {
  it("is an instance of Error with a fixed message and does not carry the original error", () => {
    const e = new DashboardSnapshotError("permission");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("DashboardSnapshotError");
    expect(e.message).toBe("Admin dashboard snapshot failed");
    expect(e.causeCode).toBe("permission");
    expect((e as unknown as { cause?: unknown }).cause).toBeUndefined();
  });

  it("every causeCode is a fixed lowercase-hyphenated token safe for redirect params", () => {
    const causes = [
      "schema",
      "permission",
      "authentication",
      "connection",
      "timeout",
      "count-unavailable",
      "unknown",
    ] as const;
    for (const cause of causes) {
      const e = new DashboardSnapshotError(cause);
      expect(e.causeCode).toBe(cause);
      expect(cause).toMatch(/^[a-z][a-z-]*$/);
      expect(cause).not.toMatch(/[&=?#/\s]/);
    }
  });
});
