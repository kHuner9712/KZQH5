import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo";
import { getPublicProductSelections } from "@/lib/repositories/products";
import { isSameSiteRequest } from "@/lib/services/http-security";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  // Phase 6: CSRF defense — reject cross-site product selection requests.
  // Although this endpoint is read-only (returns product data), validating
  // origin prevents information disclosure to malicious sites.
  if (!isSameSiteRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { ids?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.filter((id): id is string => typeof id === "string" && (UUID_PATTERN.test(id) || (isDemoMode() && id.startsWith("mock-")))))]
        .slice(0, 30)
    : [];
  try {
    const items = await getPublicProductSelections(ids);
    return NextResponse.json({ items }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Product selection refresh failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Unable to refresh products" }, { status: 500 });
  }
}

