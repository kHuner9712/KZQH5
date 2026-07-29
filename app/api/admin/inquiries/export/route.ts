import { NextRequest, NextResponse } from "next/server";
import { listInquiries } from "@/lib/repositories/inquiries";
import { getVerifiedAdmin } from "@/lib/services/admin-auth";
import { hasAdminRole } from "@/lib/services/admin-write-boundary";
import { isSameSiteRequest } from "@/lib/services/http-security";
import { inquiryFiltersFromSearchParams } from "@/lib/services/inquiries/admin-filters";
import { inquiriesToCsv } from "@/lib/services/inquiries/csv";
import type { Inquiry } from "@/types/database";

const BATCH_SIZE = 500;
const MAX_EXPORT_ROWS = 10000;

export async function GET(request: NextRequest) {
  // Phase 6: harden the export endpoint with RBAC + CSRF defense.
  //
  // requireAdminWrite is NOT used here because it enforces a
  // Content-Length check (for POST/PATCH body limits) that is
  // incompatible with GET requests (GET has no body, Content-Length
  // is typically null or 0). Instead we replicate the security
  // boundary manually:
  //   1. getVerifiedAdmin — session + profile check (401 if missing)
  //   2. hasAdminRole — RBAC: minimum role "admin" (403 if editor/unknown)
  //   3. isSameSiteRequest — CSRF defense (allows missing Origin for
  //      GET navigations, but checks Sec-Fetch-Site). This is the
  //      read-only variant: a same-origin <a href> navigation does NOT
  //      send Origin, so fail-closed on Origin would break the export
  //      link. Sec-Fetch-Site is still checked (cross-site/same-site
  //      are rejected).
  const admin = await getVerifiedAdmin();
  if (!admin.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasAdminRole(admin.profile, "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!isSameSiteRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const baseFilters = inquiryFiltersFromSearchParams(request.nextUrl.searchParams, {
    pageSizeMaximum: BATCH_SIZE,
  });
  const rows: Inquiry[] = [];
  try {
    for (let page = 1; rows.length < MAX_EXPORT_ROWS; page += 1) {
      const result = await listInquiries(admin.client, {
        ...baseFilters,
        page,
        pageSize: BATCH_SIZE,
      });
      rows.push(...result.items);
      if (result.items.length < BATCH_SIZE || rows.length >= result.total) break;
    }
  } catch (error) {
    console.error("Inquiry CSV export failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "导出失败" }, { status: 500 });
  }

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(inquiriesToCsv(rows.slice(0, MAX_EXPORT_ROWS)), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="kzq-inquiries-${date}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
