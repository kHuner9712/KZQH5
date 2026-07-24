import type { Inquiry } from "@/types/database";
import type { AdminDashboardQueries } from "@/lib/repositories/admin-dashboard";
import { DashboardSnapshotError } from "@/lib/repositories/admin-dashboard";

export interface AdminDashboardSnapshot {
  productCount: number;
  publishedCount: number;
  certificateCount: number;
  inquiryCount: number;
  unreadCount: number;
  recentInquiries: Inquiry[];
}

export type AdminDashboardResult =
  | { ok: true; data: AdminDashboardSnapshot }
  | { ok: false };

type SafeLogger = (
  message: string,
  summary: { queries: string[] },
) => void;

/**
 * Load the admin dashboard in a single snapshot RPC plus one independent
 * recent-inquiries query. Neither query uses `{ count: "exact" }`.
 *
 * Failure semantics (per spec):
 *   - Any RPC error, structurally invalid payload, missing field, wrong
 *     type, negative or oversized count -> explicit `{ ok: false }`.
 *   - The service never returns a partial/synthetic zero on failure.
 *   - The original Supabase error is never logged; only a fixed query name
 *     is passed to the logger.
 */
export async function loadAdminDashboard(
  queries: AdminDashboardQueries,
  log: SafeLogger = console.error,
): Promise<AdminDashboardResult> {
  const results = await Promise.allSettled([
    queries.getSnapshot(),
    queries.recentInquiries(),
  ]);

  const failedQueries: string[] = [];

  if (results[0].status === "rejected") {
    failedQueries.push(
      results[0].reason instanceof DashboardSnapshotError
        ? `dashboard.snapshot:${results[0].reason.causeCode}`
        : "dashboard.snapshot:unknown",
    );
  }
  if (results[1].status === "rejected") {
    failedQueries.push(
      results[1].reason instanceof DashboardSnapshotError
        ? `inquiries.recent:${results[1].reason.causeCode}`
        : "inquiries.recent:unknown",
    );
  }

  if (failedQueries.length > 0) {
    log("Admin dashboard data read failed", { queries: failedQueries });
    return { ok: false };
  }

  const snapshot = (results[0] as PromiseFulfilledResult<{
    totalProducts: number;
    publishedProducts: number;
    totalCertificates: number;
    totalInquiries: number;
    unreadInquiries: number;
  }>).value;
  const recentInquiries = (results[1] as PromiseFulfilledResult<Inquiry[]>)
    .value;

  return {
    ok: true,
    data: {
      productCount: snapshot.totalProducts,
      publishedCount: snapshot.publishedProducts,
      certificateCount: snapshot.totalCertificates,
      inquiryCount: snapshot.totalInquiries,
      unreadCount: snapshot.unreadInquiries,
      recentInquiries,
    },
  };
}
