import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {
  classifyAdminDataError,
  type AdminDataFailureCause,
} from "@/lib/services/admin-data-error";
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
  items: Array<Record<string, unknown>>
): Promise<Inquiry> {
  const client = createAdminSupabaseClient();
  const { data, error } = await client.rpc("create_inquiry_with_items", {
    p_inquiry: record,
    p_items: items,
  });
  if (error || !data) throw error || new Error("Atomic inquiry insert returned no row");
  return data as unknown as Inquiry;
}

export async function listInquiries(
  client: InquiryClient,
  filters: InquiryFilters
): Promise<InquiryListResult> {
  const page = Math.max(1, Math.floor(filters.page || 1));
  const pageSize = Math.min(500, Math.max(1, Math.floor(filters.pageSize || 20)));
  let query = client.from("inquiries").select("*, inquiry_items(*)", { count: "exact" });
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
  if (error) throw error;
  if (count === null) throw new Error("Inquiry count unavailable");
  const items = ((data as Inquiry[] | null) || []).map((inquiry) => ({
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
    throw new UnreadInquiryCountError(classifyAdminDataError(err));
  }

  const { data, error } = result;

  if (error) {
    // Supabase returned an error object. Classify by code/name only.
    // The original error object is intentionally dropped.
    throw new UnreadInquiryCountError(classifyAdminDataError(error));
  }

  const count = parseUnreadInquiryCount(data);
  if (count === null) {
    // No error, but the scalar response is not a safe non-negative integer.
    throw new UnreadInquiryCountError("count-unavailable");
  }

  return count;
}

export async function updateInquiry(
  client: InquiryClient,
  id: string,
  patch: Partial<Pick<Inquiry, "status" | "is_read" | "read_at" | "notes" | "assignee">>
): Promise<Inquiry> {
  const { data, error } = await client
    .from("inquiries")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) throw error || new Error("Inquiry update returned no row");
  return data;
}
