import { NextRequest, NextResponse } from "next/server";
import { listInquiries } from "@/lib/repositories/inquiries";
import { getVerifiedAdmin } from "@/lib/services/admin-auth";
import { hasAdminRole } from "@/lib/services/admin-write-boundary";
import { isSameSiteRequest } from "@/lib/services/http-security";
import { inquiryFiltersFromSearchParams } from "@/lib/services/inquiries/admin-filters";
import { inquiriesToCsv } from "@/lib/services/inquiries/csv";
import { getInquiryExportRateLimiter } from "@/lib/services/rate-limit";
import { logAdminAction } from "@/lib/services/admin-audit";
import type { Inquiry } from "@/types/database";

// Phase 8: Admin API routes must be dynamic to ensure middleware runs and
// CSP nonce / Cache-Control headers are injected on every request.
export const dynamic = "force-dynamic";

const BATCH_SIZE = 500;
const MAX_EXPORT_ROWS = 10000;

export async function GET(request: NextRequest) {
  // Phase 6 + Phase 8: harden the export endpoint with RBAC + CSRF
  // defense + dedicated rate limiting + audit logging.
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
  //   4. Phase 8: dedicated export rate limiter (5 exports / 60s / admin)
  //      — CSV export loops in batches of 500 up to 10000 rows, so each
  //      export is up to 20 DB queries. The shared admin API limiter
  //      (60/min) is too generous for this heavy operation.
  //   5. Phase 8: audit log — exports download customer PII (name,
  //      phone, email, message). Compliance requires tracking who
  //      exported what and when. The audit is best-effort (the export
  //      proceeds even if the audit insert fails) because this is a
  //      read operation; the audit is a forensic record, not a gate.
  const admin = await getVerifiedAdmin();
  if (!admin.ok) {
    return NextResponse.json({ error: "ADMIN_WRITE_UNAUTHORIZED" }, { status: 401 });
  }

  if (!hasAdminRole(admin.profile, "admin")) {
    return NextResponse.json({ error: "ADMIN_WRITE_FORBIDDEN_ROLE" }, { status: 403 });
  }

  if (!isSameSiteRequest(request)) {
    return NextResponse.json({ error: "ADMIN_WRITE_FORBIDDEN_ORIGIN" }, { status: 403 });
  }

  // Phase 8: dedicated export rate limiter (per admin actor).
  const exportRateKey = `inquiry-export:${admin.user.id}`;
  const exportRate = await getInquiryExportRateLimiter().check(exportRateKey);
  if (!exportRate.allowed) {
    return NextResponse.json(
      { error: "ADMIN_WRITE_RATE_LIMITED" },
      {
        status: 429,
        headers: {
          "Retry-After": String(exportRate.retryAfterSeconds),
          "Cache-Control": "no-store",
        },
      },
    );
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
  } catch {
    // Log only the fixed code — never the Supabase error payload.
    console.warn("INQUIRY_EXPORT_FAILED");
    return NextResponse.json({ error: "ADMIN_WRITE_FAILED" }, { status: 500 });
  }

  const exportedRows = rows.slice(0, MAX_EXPORT_ROWS);

  // Phase 8: audit the export (best-effort). Record who exported, the
  // filter criteria, and the row count. Do NOT record the PII itself —
  // the summary is action + target identification only.
  await logAdminAction(
    admin.client,
    { id: admin.user.id, email: admin.user.email, role: admin.profile.role },
    {
      action: "inquiry.export",
      targetType: "inquiry",
      targetId: null,
      summary: `Exported ${exportedRows.length} inquiries to CSV (filters: ${request.nextUrl.search || "none"})`,
    },
  );

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(inquiriesToCsv(exportedRows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="kzq-inquiries-${date}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
