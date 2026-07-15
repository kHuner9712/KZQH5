import type { Inquiry } from "@/types/database";
import type { AdminDashboardQueries } from "@/lib/repositories/admin-dashboard";
import { DashboardQueryError } from "@/lib/repositories/admin-dashboard";

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

export async function loadAdminDashboard(
  queries: AdminDashboardQueries,
  log: SafeLogger = console.error,
): Promise<AdminDashboardResult> {
  const results = await Promise.allSettled([
    queries.totalProducts(),
    queries.publishedProducts(),
    queries.totalCertificates(),
    queries.totalInquiries(),
    queries.unreadInquiries(),
    queries.recentInquiries(),
  ]);

  const failedQueries = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    if (result.reason instanceof DashboardQueryError) {
      return [result.reason.queryName];
    }
    return [
      [
        "products.total",
        "products.published",
        "certificates.total",
        "inquiries.total",
        "inquiries.unread",
        "inquiries.recent",
      ][index],
    ];
  });

  if (failedQueries.length > 0) {
    log("Admin dashboard data read failed", { queries: failedQueries });
    return { ok: false };
  }

  return {
    ok: true,
    data: {
      productCount: (results[0] as PromiseFulfilledResult<number>).value,
      publishedCount: (results[1] as PromiseFulfilledResult<number>).value,
      certificateCount: (results[2] as PromiseFulfilledResult<number>).value,
      inquiryCount: (results[3] as PromiseFulfilledResult<number>).value,
      unreadCount: (results[4] as PromiseFulfilledResult<number>).value,
      recentInquiries: (results[5] as PromiseFulfilledResult<Inquiry[]>).value,
    },
  };
}
