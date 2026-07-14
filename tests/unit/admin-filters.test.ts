import { describe, expect, it } from "vitest";
import { inquiryFiltersFromSearchParams } from "@/lib/services/inquiries/admin-filters";

describe("inquiry export filters", () => {
  it("preserves the current supported filters", () => {
    const params = new URLSearchParams({
      search: "广州,Buyer",
      status: "contacted",
      language: "en",
      source: "google",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-15",
      unread: "true",
      page: "3",
      pageSize: "500",
    });

    expect(
      inquiryFiltersFromSearchParams(params, { pageSizeMaximum: 500 }),
    ).toEqual({
      search: "广州,Buyer",
      status: "contacted",
      language: "en",
      source: "google",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-15",
      unread: true,
      page: 3,
      pageSize: 500,
    });
  });

  it("bounds invalid paging and ignores invalid enum values", () => {
    const params = new URLSearchParams({
      status: "deleted",
      language: "fr",
      page: "-8",
      pageSize: "99999",
    });

    expect(inquiryFiltersFromSearchParams(params)).toMatchObject({
      status: "all",
      language: "all",
      page: 1,
      pageSize: 100,
    });
  });
});
