import { describe, expect, it, vi } from "vitest";
import { DashboardSnapshotError, createAdminDashboardQueries } from "@/lib/repositories/admin-dashboard";
import { loadAdminDashboard } from "@/lib/services/admin-dashboard";
import type { Inquiry } from "@/types/database";

// ============================================================
// KZQ-P2-002: dashboard query convergence
// ------------------------------------------------------------
// The dashboard must rely on the SINGLE get_admin_dashboard_snapshot
// RPC plus one independent recent-inquiries query — the former 5-query
// table-count fallback (getSnapshotViaDirectQueries) is removed:
//   - getSnapshot never issues `from(...)` count queries;
//   - any RPC failure (error field or transport throw) surfaces as a
//     fixed DashboardSnapshotError (explicit failure, no fallback);
//   - loadAdminDashboard performs exactly 2 queries (1 RPC + 1 recent).
// ============================================================

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

function snapshot() {
  return {
    total_products: 3,
    published_products: 2,
    total_certificates: 1,
    total_inquiries: 2,
    unread_inquiries: 1,
  };
}

/** Client where rpc/from are recorded spies (from never returns counts). */
function makeClient(opts: { rpcResult?: () => unknown; rpcThrow?: boolean } = {}) {
  const rpc = vi.fn(async () => {
    if (opts.rpcThrow) throw new Error("rpc transport failed");
    const value = opts.rpcResult ? opts.rpcResult() : { data: null, error: null };
    return value as never;
  });
  const from = vi.fn<(table: string) => unknown>(() => {
    throw new Error("from() must never be called on the snapshot path");
  });
  return { client: { rpc, from } as never, rpc, from };
}

describe("KZQ-P2-002: dashboard query convergence", () => {
  it("getSnapshot issues ONLY the single RPC (no table-count fallback queries)", async () => {
    const { client, rpc, from } = makeClient({
      rpcResult: () => ({ data: snapshot(), error: null }),
    });

    const queries = createAdminDashboardQueries(client);
    const result = await queries.getSnapshot();

    expect(result).toEqual({
      totalProducts: 3,
      publishedProducts: 2,
      totalCertificates: 1,
      totalInquiries: 2,
      unreadInquiries: 1,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("get_admin_dashboard_snapshot");
    // The removed 5-query fallback must never run.
    expect(from).not.toHaveBeenCalled();
  });

  it("throws DashboardSnapshotError on an RPC error field and never falls back", async () => {
    const { client, rpc, from } = makeClient({
      rpcResult: () => ({
        data: null,
        error: { code: "PGRST205", name: "PostgrestError" }, // relation not found
      }),
    });

    const queries = createAdminDashboardQueries(client);
    await expect(queries.getSnapshot()).rejects.toThrow(DashboardSnapshotError);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });

  it("throws DashboardSnapshotError on an RPC transport throw and never falls back", async () => {
    const { client, rpc, from } = makeClient({ rpcThrow: true });

    const queries = createAdminDashboardQueries(client);
    await expect(queries.getSnapshot()).rejects.toThrow(DashboardSnapshotError);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });

  it("loadAdminDashboard performs exactly two queries (snapshot RPC + recent inquiries)", async () => {
    const { client, rpc, from } = makeClient({
      rpcResult: () => ({ data: snapshot(), error: null }),
    });
    // recentInquiries is the only legitimate from() call on the dashboard.
    from.mockImplementationOnce(() => ({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: [realInquiry], error: null }),
        }),
      }),
    }));

    const queries = createAdminDashboardQueries(client);
    const result = await loadAdminDashboard(queries);

    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("inquiries");
  });
});
