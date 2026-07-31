import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {
  classifyAdminDataError,
  type AdminDataFailureCause,
} from "@/lib/services/admin-data-error";
import {
  SCHEMA_COMPAT_DISABLED_LOG_CODE,
  shouldUseSchemaCompatFallback,
} from "@/lib/config/schema-compat";
import { normalizeSearchTerm } from "@/lib/utils";
import type { Database, Inquiry, InquiryStatus } from "@/types/database";
import type { InquiryCreateRecord } from "@/lib/services/inquiries/validation";

/**
 * Fixed error thrown by {@link countUnreadInquiries} when the Supabase query
 * fails or returns no count. Carries ONLY a coarse {@link AdminDataFailureCause}
 * so the protected layout can redirect with a safe `cause` query param.
 *
 * Safety contract:
 *   - message is a fixed constant string
 *   - the original Supabase error is NEVER stored on this Error (no `cause`,
 *     no private fields holding message/details/hint/stack/url/headers)
 *   - `causeCode` is one of the fixed enum values, safe to log and to expose
 *     in redirect query params
 */
export class UnreadInquiryCountError extends Error {
  readonly causeCode: AdminDataFailureCause;

  constructor(causeCode: AdminDataFailureCause) {
    super("Unread inquiry count failed");
    this.name = "UnreadInquiryCountError";
    this.causeCode = causeCode;
  }
}

export interface InquiryFilters {
  search?: string;
  status?: InquiryStatus | "all";
  language?: "zh" | "en" | "all";
  source?: string;
  dateFrom?: string;
  dateTo?: string;
  unread?: boolean;
  page?: number;
  pageSize?: number;
}

export interface InquiryListResult {
  items: Inquiry[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Phase 5: result of the idempotent create_inquiry_with_items RPC.
 * - `inquiry`     : the inquiry row (newly inserted OR existing on idempotent hit)
 * - `idempotent`  : true when the call hit an existing client_submission_id
 * - `outboxId`    : outbox event id written in the same transaction, or null
 *                   when idempotent=true (no new outbox row was created)
 */
export interface InquirySubmissionRpcResult {
  inquiry: Inquiry;
  idempotent: boolean;
  outboxId: string | null;
}

type InquiryClient = SupabaseClient<Database>;

function parseUnreadInquiryCount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }

  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export async function createInquiry(record: InquiryCreateRecord): Promise<Inquiry> {
  const client = createAdminSupabaseClient();
  const { data, error } = await client
    .from("inquiries")
    .insert(record as Database["public"]["Tables"]["inquiries"]["Insert"])
    .select("*")
    .single();
  if (error || !data) throw error || new Error("Inquiry insert returned no row");
  return data;
}

export async function createInquiryWithItems(
  record: InquiryCreateRecord,
  items: Array<Record<string, unknown>>,
  clientSubmissionId?: string | null,
): Promise<InquirySubmissionRpcResult> {
  const client = createAdminSupabaseClient();
  const { data, error } = await client.rpc("create_inquiry_with_items", {
    p_inquiry: record,
    p_items: items,
    p_client_submission_id: clientSubmissionId ?? null,
  });
  if (error || !data) {
    throw error || new Error("Atomic inquiry insert returned no row");
  }

  // Phase 5: RPC returns { inquiry, idempotent, outbox_id }.
  // Defensive parse — never trust the shape blindly.
  const payload = data as unknown as Record<string, unknown>;
  const inquiryRaw = payload?.inquiry;
  if (!inquiryRaw || typeof inquiryRaw !== "object") {
    throw new Error("Atomic inquiry insert returned malformed payload");
  }
  const inquiry = inquiryRaw as unknown as Inquiry;

  const idempotent =
    typeof payload.idempotent === "boolean" ? payload.idempotent : false;
  const outboxId =
    typeof payload.outbox_id === "string" ? payload.outbox_id : null;

  return { inquiry, idempotent, outboxId };
}

export async function listInquiries(
  client: InquiryClient,
  filters: InquiryFilters
): Promise<InquiryListResult> {
  const page = Math.max(1, Math.floor(filters.page || 1));
  const pageSize = Math.min(500, Math.max(1, Math.floor(filters.pageSize || 20)));

  // Try with inquiry_items relation first. If the inquiry_items table is
  // not deployed (or the relation is missing), fall back to inquiries-only
  // query so the admin list still works.
  const result = await runInquiryQuery(client, filters, page, pageSize, true);
  if (result) return result;

  // Fallback: without inquiry_items relation.
  const fallback = await runInquiryQuery(client, filters, page, pageSize, false);
  if (fallback) return fallback;

  // Both attempts failed — the primary error is re-thrown below.
  throw new Error("读取询盘失败");
}

/**
 * Run the inquiry list query with or without the inquiry_items relation.
 * Returns null if the query fails with a schema error (relation/table
 * missing), so the caller can retry with the fallback. Returns the result
 * on success. Re-throws non-schema errors.
 */
async function runInquiryQuery(
  client: InquiryClient,
  filters: InquiryFilters,
  page: number,
  pageSize: number,
  withItems: boolean,
): Promise<InquiryListResult | null> {
  const select = withItems
    ? "*, inquiry_items(*)"
    : "*";
  let query = client.from("inquiries").select(select, { count: "exact" });
  if (filters.status && filters.status !== "all") query = query.eq("status", filters.status);
  if (filters.language && filters.language !== "all") query = query.eq("language", filters.language);
  if (filters.source) query = query.eq("source", filters.source);
  if (filters.unread) query = query.eq("is_read", false);
  if (filters.dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(filters.dateFrom)) {
    query = query.gte("created_at", `${filters.dateFrom}T00:00:00.000Z`);
  }
  if (filters.dateTo && /^\d{4}-\d{2}-\d{2}$/.test(filters.dateTo)) {
    query = query.lte("created_at", `${filters.dateTo}T23:59:59.999Z`);
  }
  const search = normalizeSearchTerm(filters.search);
  if (search) {
    query = query.or(
      `name.ilike.%${search}%,company.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%,wechat.ilike.%${search}%,whatsapp.ilike.%${search}%,interested_product.ilike.%${search}%`
    );
  }
  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (error) {
    // Schema errors (table/relation/column missing) → return null to
    // signal the caller to try the fallback. Other errors throw.
    const cause = classifyAdminDataError(error);
    if (cause === "schema" && withItems) {
      return null;
    }
    throw error;
  }
  if (count === null) throw new Error("Inquiry count unavailable");
  const items = ((data as unknown as Inquiry[] | null) || []).map((inquiry) => ({
    ...inquiry,
    inquiry_items: [...(inquiry.inquiry_items || [])].sort((a, b) => a.sort_order - b.sort_order),
  }));
  return { items, total: count, page, pageSize };
}

export async function countUnreadInquiries(client: InquiryClient): Promise<number> {
  let result: { data: unknown; error: unknown };

  try {
    result = await client.rpc("count_unread_inquiries");
  } catch (err) {
    // fetch or client-side throw (network, abort, etc.). Classify by code/name
    // only; never propagate the original error object.
    const cause = classifyAdminDataError(err);
    // KZQ-P0-010: schema/permission fallback is gated by an explicit env
    // switch. In production it defaults OFF so an undeployed RPC surfaces
    // as a fixed error instead of silently masking a missing migration.
    if (shouldUseSchemaCompatFallback(cause)) {
      return countUnreadInquiriesViaDirectQuery(client);
    }
    if (cause === "schema" || cause === "permission") {
      console.warn(SCHEMA_COMPAT_DISABLED_LOG_CODE);
    }
    throw new UnreadInquiryCountError(cause);
  }

  const { data, error } = result;

  if (error) {
    const cause = classifyAdminDataError(error);
    // KZQ-P0-010: gated fallback for schema/permission errors (RPC not deployed).
    if (shouldUseSchemaCompatFallback(cause)) {
      return countUnreadInquiriesViaDirectQuery(client);
    }
    if (cause === "schema" || cause === "permission") {
      console.warn(SCHEMA_COMPAT_DISABLED_LOG_CODE);
    }
    // Supabase returned an error object. Classify by code/name only.
    // The original error object is intentionally dropped.
    throw new UnreadInquiryCountError(cause);
  }

  const count = parseUnreadInquiryCount(data);
  if (count === null) {
    // No error, but the scalar response is not a safe non-negative integer.
    throw new UnreadInquiryCountError("count-unavailable");
  }

  return count;
}

/**
 * Fallback for countUnreadInquiries when the RPC is not deployed.
 * Uses a direct table count query with the service_role client.
 */
async function countUnreadInquiriesViaDirectQuery(
  client: InquiryClient,
): Promise<number> {
  const { count, error } = await client
    .from("inquiries")
    .select("*", { count: "exact", head: true })
    .eq("is_read", false);
  if (error) {
    throw new UnreadInquiryCountError(classifyAdminDataError(error));
  }
  if (count === null) {
    throw new UnreadInquiryCountError("count-unavailable");
  }
  return count;
}

/**
 * Phase 3: Update an inquiry with optional optimistic locking.
 *
 * When `expectedUpdatedAt` is provided, the UPDATE only succeeds if the
 * row's `updated_at` matches. If zero rows are updated (stale version or
 * row missing), an error with code 'PGRST116' (no rows returned by .single())
 * or a check is performed to distinguish conflict from not-found.
 *
 * Throws an Error with `code` property set to '40P01' for stale version
 * (conflict) so the caller can map it to HTTP 409.
 */
export async function updateInquiry(
  client: InquiryClient,
  id: string,
  patch: Partial<Pick<Inquiry, "status" | "is_read" | "read_at" | "notes" | "assignee">>,
  expectedUpdatedAt?: string | null,
): Promise<Inquiry> {
  let query = client
    .from("inquiries")
    .update(patch)
    .eq("id", id);

  // Phase 3: optimistic lock — only update if updated_at matches.
  if (expectedUpdatedAt) {
    query = query.eq("updated_at", expectedUpdatedAt);
  }

  const { data, error } = await query.select("*").maybeSingle();

  if (error) {
    throw error;
  }

  // Phase 3: if no row was updated and optimistic lock was active,
  // check whether the row exists to distinguish conflict from not-found.
  if (!data) {
    if (expectedUpdatedAt) {
      const { data: existsRow } = await client
        .from("inquiries")
        .select("id")
        .eq("id", id)
        .maybeSingle();
      if (existsRow) {
        // Row exists but updated_at mismatch → conflict
        const conflictError = new Error("Inquiry updated by another transaction");
        (conflictError as Error & { code?: string }).code = "40P01";
        throw conflictError;
      }
    }
    throw new Error("Inquiry update returned no row");
  }

  return data;
}
