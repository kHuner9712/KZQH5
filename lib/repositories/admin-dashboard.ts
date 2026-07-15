import type { Inquiry } from "@/types/database";
import type { createServerSupabaseClient } from "@/lib/supabase/server";

type DashboardClient = ReturnType<typeof createServerSupabaseClient>;

export class DashboardQueryError extends Error {
  constructor(readonly queryName: string) {
    super(`Dashboard query failed: ${queryName}`);
    this.name = "DashboardQueryError";
  }
}

function exactCount(
  queryName: string,
  result: { count: number | null; error: unknown },
): number {
  if (result.error || result.count === null) {
    throw new DashboardQueryError(queryName);
  }
  return result.count;
}

export interface AdminDashboardQueries {
  totalProducts(): Promise<number>;
  publishedProducts(): Promise<number>;
  totalCertificates(): Promise<number>;
  totalInquiries(): Promise<number>;
  unreadInquiries(): Promise<number>;
  recentInquiries(): Promise<Inquiry[]>;
}

export function createAdminDashboardQueries(
  client: DashboardClient,
): AdminDashboardQueries {
  return {
    async totalProducts() {
      const result = await client
        .from("products")
        .select("id", { count: "exact" })
        .limit(1);
      return exactCount("products.total", result);
    },
    async publishedProducts() {
      const result = await client
        .from("products")
        .select("id", { count: "exact" })
        .eq("is_published", true)
        .limit(1);
      return exactCount("products.published", result);
    },
    async totalCertificates() {
      const result = await client
        .from("certificates")
        .select("id", { count: "exact" })
        .limit(1);
      return exactCount("certificates.total", result);
    },
    async totalInquiries() {
      const result = await client
        .from("inquiries")
        .select("id", { count: "exact" })
        .limit(1);
      return exactCount("inquiries.total", result);
    },
    async unreadInquiries() {
      const result = await client
        .from("inquiries")
        .select("id", { count: "exact" })
        .eq("is_read", false)
        .limit(1);
      return exactCount("inquiries.unread", result);
    },
    async recentInquiries() {
      const { data, error } = await client
        .from("inquiries")
        .select(
          "id, name, status, is_read, interested_product, message, created_at, country",
        )
        .order("created_at", { ascending: false })
        .limit(5);
      if (error || !data) throw new DashboardQueryError("inquiries.recent");
      return data as Inquiry[];
    },
  };
}
