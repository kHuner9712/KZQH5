import type { InquiryFilters } from "@/lib/repositories/inquiries";
import type { InquiryStatus } from "@/types/database";

const statuses = new Set<InquiryStatus>(["new", "contacted", "closed"]);

export function inquiryFiltersFromSearchParams(
  params: URLSearchParams,
  options?: { pageSizeMaximum?: number }
): InquiryFilters {
  const statusValue = params.get("status");
  const languageValue = params.get("language");
  const requestedPageSize = Number(params.get("pageSize"));
  const pageSizeMaximum = options?.pageSizeMaximum || 100;
  return {
    search: params.get("search") || undefined,
    status: statusValue && statuses.has(statusValue as InquiryStatus)
      ? statusValue as InquiryStatus
      : "all",
    language: languageValue === "zh" || languageValue === "en" ? languageValue : "all",
    source: (params.get("source") || "").slice(0, 80) || undefined,
    dateFrom: params.get("dateFrom") || undefined,
    dateTo: params.get("dateTo") || undefined,
    unread: params.get("unread") === "true",
    page: Math.max(1, Number(params.get("page")) || 1),
    pageSize: Math.min(
      pageSizeMaximum,
      Math.max(1, Number.isFinite(requestedPageSize) && requestedPageSize ? requestedPageSize : 20)
    ),
  };
}
