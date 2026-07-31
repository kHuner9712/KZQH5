import type { SupabaseClient } from "@supabase/supabase-js";
import type { createServerSupabaseClient } from "@/lib/supabase/server";
import type { Database, Inquiry } from "@/types/database";
import {
  classifyAdminDataError,
  type AdminDataFailureCause,
} from "@/lib/services/admin-data-error";
import {
  SCHEMA_COMPAT_DISABLED_LOG_CODE,
  shouldUseSchemaCompatFallback,
} from "@/lib/config/schema-compat";

type DashboardClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

/**
 * Fixed error thrown when the dashboard snapshot RPC fails or returns a
 * structurally invalid payload. Carries ONLY a coarse {@link AdminDataFailureCause}
 * so the service layer can return an explicit failure state without leaking
 * any Supabase error detail.
 *
 * Safety contract (mirrors UnreadInquiryCountError):
 *   - message is a fixed constant string
 *   - the original Supabase error is NEVER stored (no `cause`, no private
 *     fields holding message/details/hint/stack/url/headers)
 *   - `causeCode` is one of the fixed enum values, safe to log and redirect
 */
export class DashboardSnapshotError extends Error {
  readonly causeCode: AdminDataFailureCause;

  constructor(causeCode: AdminDataFailureCause) {
    super("Admin dashboard snapshot failed");
    this.name = "DashboardSnapshotError";
    this.causeCode = causeCode;
  }
}

export interface DashboardSnapshotCounts {
  totalProducts: number;
  publishedProducts: number;
  totalCertificates: number;
  totalInquiries: number;
  unreadInquiries: number;
}

export interface AdminDashboardQueries {
  /** Single-RPC snapshot of the five dashboard counts. */
  getSnapshot(): Promise<DashboardSnapshotCounts>;
  /** Independent recent-inquiries list (kept separate per spec). */
  recentInquiries(): Promise<Inquiry[]>;
}

const SNAPSHOT_FIELDS = [
  "total_products",
  "published_products",
  "total_certificates",
  "total_inquiries",
  "unread_inquiries",
] as const;

/**
 * Parse a single count value. Accepts:
 *   - a non-negative safe integer number
 *   - a decimal string of digits ("0".."999...") that converts to a
 *     non-negative safe integer
 * Rejects: negatives, fractions, NaN, Infinity, numbers above
 * MAX_SAFE_INTEGER, signed strings, scientific notation, booleans, objects.
 * Returns null when the value is not an acceptable count.
 */
function parseCount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/**
 * Strictly validate the RPC return payload and return the five counts.
 *
 * Accepts either:
 *   - a single object  `{ total_products, ... }`  (composite return)
 *   - an array with exactly one such object       (table return)
 *
 * Every required field must be present and be a non-negative safe integer
 * or a safely-convertible decimal string. Any missing field, wrong type,
 * negative value, oversized value, or unexpected shape throws
 * {@link DashboardSnapshotError} with causeCode "count-unavailable".
 */
export function parseDashboardSnapshot(data: unknown): DashboardSnapshotCounts {
  let row: unknown = data;
  if (Array.isArray(data)) {
    if (data.length !== 1) {
      throw new DashboardSnapshotError("count-unavailable");
    }
    row = data[0];
  }

  if (!row || typeof row !== "object") {
    throw new DashboardSnapshotError("count-unavailable");
  }

  const record = row as Record<string, unknown>;
  const result: Partial<DashboardSnapshotCounts> = {};

  for (const field of SNAPSHOT_FIELDS) {
    const raw = record[field];
    const count = parseCount(raw);
    if (count === null) {
      throw new DashboardSnapshotError("count-unavailable");
    }
    switch (field) {
      case "total_products":
        result.totalProducts = count;
        break;
      case "published_products":
        result.publishedProducts = count;
        break;
      case "total_certificates":
        result.totalCertificates = count;
        break;
      case "total_inquiries":
        result.totalInquiries = count;
        break;
      case "unread_inquiries":
        result.unreadInquiries = count;
        break;
    }
  }

  return result as DashboardSnapshotCounts;
}

export function createAdminDashboardQueries(
  client: DashboardClient,
): AdminDashboardQueries {
  return {
    async getSnapshot() {
      // Try the snapshot RPC first. If it is not deployed (schema error)
      // or permission-denied, fall back to direct table count queries
      // ONLY when the schema-compat fallback is explicitly allowed
      // (KZQ-P0-010). In production the fallback defaults OFF so an
      // undeployed RPC surfaces as a fixed error instead of silently
      // masking a missing migration.
      try {
        const result = await client.rpc("get_admin_dashboard_snapshot");
        const { data, error } = result;
        if (!error) {
          return parseDashboardSnapshot(data);
        }
        // If the error is NOT a schema/permission issue, treat as a real
        // failure. Schema/permission errors (RPC not deployed, or
        // execute privilege missing) fall through to the gated fallback.
        const cause = classifyAdminDataError(error);
        if (!shouldUseSchemaCompatFallback(cause)) {
          if (cause === "schema" || cause === "permission") {
            console.warn(SCHEMA_COMPAT_DISABLED_LOG_CODE);
          }
          throw new DashboardSnapshotError(cause);
        }
      } catch (err) {
        // If this is already a DashboardSnapshotError from above, re-throw.
        if (err instanceof DashboardSnapshotError) throw err;
        // Network/abort/client throw — classify and check if fallback is
        // appropriate. Connection errors should NOT fall back.
        const cause = classifyAdminDataError(err);
        if (!shouldUseSchemaCompatFallback(cause)) {
          if (cause === "schema" || cause === "permission") {
            console.warn(SCHEMA_COMPAT_DISABLED_LOG_CODE);
          }
          throw new DashboardSnapshotError(cause);
        }
      }

      // Fallback: direct table count queries using service_role (bypasses
      // RLS). Used when the snapshot RPC is not deployed to the database
      // AND the schema-compat fallback is explicitly allowed.
      return getSnapshotViaDirectQueries(client);
    },

    async recentInquiries() {
      const { data, error } = await client
        .from("inquiries")
        .select(
          "id, name, status, is_read, interested_product, message, created_at, country",
        )
        .order("created_at", { ascending: false })
        .limit(5);
      if (error || !data) {
        throw new DashboardSnapshotError("count-unavailable");
      }
      return data as Inquiry[];
    },
  };
}

/**
 * Fallback snapshot implementation using direct table count queries.
 * Used when the get_admin_dashboard_snapshot RPC is not deployed.
 *
 * Uses { count: "exact", head: true } to avoid transferring row data —
 * only the count is needed. service_role bypasses RLS, so this returns
 * true totals even on tables with restrictive policies.
 */
async function getSnapshotViaDirectQueries(
  client: DashboardClient,
): Promise<DashboardSnapshotCounts> {
  const [products, publishedProducts, certificates, inquiries, unreadInquiries] =
    await Promise.all([
      client.from("products").select("*", { count: "exact", head: true }),
      client
        .from("products")
        .select("*", { count: "exact", head: true })
        .eq("is_published", true),
      client.from("certificates").select("*", { count: "exact", head: true }),
      client.from("inquiries").select("*", { count: "exact", head: true }),
      client
        .from("inquiries")
        .select("*", { count: "exact", head: true })
        .eq("is_read", false),
    ]);

  const errors = [products, publishedProducts, certificates, inquiries, unreadInquiries]
    .filter((r) => r.error);
  if (errors.length > 0) {
    throw new DashboardSnapshotError(
      classifyAdminDataError(errors[0].error),
    );
  }

  const counts = [
    products.count,
    publishedProducts.count,
    certificates.count,
    inquiries.count,
    unreadInquiries.count,
  ];
  if (counts.some((c) => c === null)) {
    throw new DashboardSnapshotError("count-unavailable");
  }

  return {
    totalProducts: counts[0] as number,
    publishedProducts: counts[1] as number,
    totalCertificates: counts[2] as number,
    totalInquiries: counts[3] as number,
    unreadInquiries: counts[4] as number,
  };
}

/**
 * Convenience helper for callers that already hold a typed client (used by
 * tests). Kept here so the parsing logic is co-located with the repository.
 */
export function parseSnapshotFromClient(
  client: SupabaseClient<Database>,
): Promise<DashboardSnapshotCounts> {
  return createAdminDashboardQueries(
    client as unknown as DashboardClient,
  ).getSnapshot();
}
