import { describe, expect, it, vi } from "vitest";
import type { AdminDashboardQueries } from "@/lib/repositories/admin-dashboard";
import { DashboardQueryError } from "@/lib/repositories/admin-dashboard";
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

function makeQueries(
  overrides: Partial<AdminDashboardQueries> = {},
): AdminDashboardQueries {
  return {
    totalProducts: vi.fn().mockResolvedValue(3),
    publishedProducts: vi.fn().mockResolvedValue(2),
    totalCertificates: vi.fn().mockResolvedValue(1),
    totalInquiries: vi.fn().mockResolvedValue(2),
    unreadInquiries: vi.fn().mockResolvedValue(1),
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
        totalInquiries: vi.fn().mockResolvedValue(2),
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

  it("returns an explicit error state instead of zero on query failure", async () => {
    const log = vi.fn();
    const result = await loadAdminDashboard(
      makeQueries({
        totalProducts: vi
          .fn()
          .mockRejectedValue(new DashboardQueryError("products.total")),
      }),
      log,
    );

    expect(result).toEqual({ ok: false });
    expect(log).toHaveBeenCalledWith("Admin dashboard data read failed", {
      queries: ["products.total"],
    });
  });

  it("shows real zeros for empty tables", async () => {
    const result = await loadAdminDashboard(
      makeQueries({
        totalProducts: vi.fn().mockResolvedValue(0),
        publishedProducts: vi.fn().mockResolvedValue(0),
        totalCertificates: vi.fn().mockResolvedValue(0),
        totalInquiries: vi.fn().mockResolvedValue(0),
        unreadInquiries: vi.fn().mockResolvedValue(0),
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
      makeQueries({ unreadInquiries: vi.fn().mockResolvedValue(2) }),
    );
    expect(result).toMatchObject({ ok: true, data: { unreadCount: 2 } });
  });

  it("reflects a product publish-state change on the next read", async () => {
    const publishedProducts = vi
      .fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    const queries = makeQueries({ publishedProducts });

    const before = await loadAdminDashboard(queries);
    const after = await loadAdminDashboard(queries);

    expect(before).toMatchObject({ ok: true, data: { publishedCount: 2 } });
    expect(after).toMatchObject({ ok: true, data: { publishedCount: 1 } });
  });

  it("reflects certificate additions and deletions on subsequent reads", async () => {
    const totalCertificates = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    const queries = makeQueries({ totalCertificates });

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
        totalInquiries: vi.fn().mockRejectedValue(new Error(sensitiveMessage)),
      }),
      log,
    );

    expect(JSON.stringify(result)).not.toContain(sensitiveMessage);
    expect(JSON.stringify(log.mock.calls)).not.toContain(sensitiveMessage);
    expect(log).toHaveBeenCalledWith("Admin dashboard data read failed", {
      queries: ["inquiries.total"],
    });
  });
});
