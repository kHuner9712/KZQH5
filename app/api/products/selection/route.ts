import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demo";
import { getPublicProductSelections } from "@/lib/repositories/products";
import {
  ephemeralRateKey,
  isSameSiteRequest,
  readJsonBody,
  UUID_PATTERN,
} from "@/lib/services/http-security";
import { getAnalyticsRateLimiter } from "@/lib/services/rate-limit";

// ============================================================
// /api/products/selection
// ------------------------------------------------------------
// Public POST endpoint that returns the latest snapshot of a small set
// of products selected by the catalog/cart UI. Hardened:
//   - CSRF (isSameSiteRequest)
//   - 8 KB body cap (declared Content-Length AND actual byte count)
//   - Strict Content-Type: application/json
//   - Per-IP rate limiting (60 selections / 60s — read-only, intentionally
//     more generous than inquiry but still bounded)
//   - Hard cap of 30 IDs per request
//   - Each ID MUST be a UUID (or mock-* only in Demo mode)
//   - Cache-Control: private, no-store (auth-aware responses)
// ============================================================

const MAX_BODY_BYTES = 8 * 1024;
const MAX_IDS = 30;

export async function POST(request: NextRequest) {
  // Phase 6: CSRF defense — reject cross-site product selection requests.
  // Although this endpoint is read-only (returns product data), validating
  // origin prevents information disclosure to malicious sites.
  if (!isSameSiteRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Rate limit BEFORE reading the body so an attacker cannot exhaust
  // request-body parsing budget while bypassing the limiter.
  const rate = await getAnalyticsRateLimiter().check(ephemeralRateKey(request));
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const parsed = await readJsonBody<{ ids?: unknown }>(request, MAX_BODY_BYTES);
  if (!parsed.ok) {
    const error =
      parsed.status === 413
        ? "Payload too large"
        : parsed.status === 415
          ? "Content-Type must be application/json"
          : "Invalid request body";
    return NextResponse.json({ error }, { status: parsed.status });
  }

  // Strict shape check: body must be a plain object with optional `ids` array.
  // Reject nested objects, arrays at top level, and oversized string fields.
  const body = parsed.value;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.prototype.toString.call(body) !== "[object Object]"
  ) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const rawIds = body.ids;
  if (rawIds !== undefined && !Array.isArray(rawIds)) {
    return NextResponse.json({ error: "ids must be an array" }, { status: 400 });
  }

  const allowMockIds = isDemoMode();
  const ids = Array.isArray(rawIds)
    ? [
        ...new Set(
          rawIds.filter(
            (id): id is string =>
              typeof id === "string" &&
              id.length <= 36 &&
              (UUID_PATTERN.test(id) || (allowMockIds && id.startsWith("mock-"))),
          ),
        ),
      ].slice(0, MAX_IDS)
    : [];

  try {
    const items = await getPublicProductSelections(ids);
    return NextResponse.json(
      { items },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    // Fixed coarse log code only — never the raw Supabase error which may
    // contain SQL text, parameter values, or PII.
    const causeName =
      error instanceof Error ? error.name : typeof error === "string" ? error : "UnknownError";
    console.error(`PRODUCT_SELECTION_FAILED code=${causeName}`);
    return NextResponse.json(
      { error: "Unable to refresh products" },
      { status: 500 },
    );
  }
}

export function GET() {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405 });
}
