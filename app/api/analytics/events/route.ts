import { NextRequest, NextResponse } from "next/server";
import { recordAnalyticsEvent } from "@/lib/repositories/analytics";
import { validateAnalyticsEvent } from "@/lib/services/analytics/validation";
import { getAnalyticsRateLimiter } from "@/lib/services/rate-limit";
import {
  checkRateLimitKeys,
  isSameSiteRequest,
  readJsonBody,
} from "@/lib/services/http-security";

// ============================================================
// /api/analytics/events
// ------------------------------------------------------------
// Public POST endpoint that records a single client-side analytics event.
// Hardened:
//   - CSRF (isSameSiteRequest)
//   - Strict Content-Type: application/json
//   - 8 KB body cap (declared Content-Length AND actual byte count)
//   - Per-IP rate limiting (60 events / 60s)
//   - Strict allowlist of event_name values (validated downstream)
//   - Fixed coarse log codes only — never raw Supabase error.message
//   - Cache-Control: no-store
// ============================================================

const MAX_BODY_BYTES = 8 * 1024;

export async function POST(request: NextRequest) {
  // Phase 6: CSRF defense — reject cross-site analytics injection.
  // Analytics events should only come from our own site. A malicious site
  // sending POST requests here could pollute analytics data or waste
  // database resources.
  if (!isSameSiteRequest(request)) {
    return NextResponse.json(
      { success: false, error: "Forbidden" },
      { status: 403 },
    );
  }

  // Rate limit BEFORE reading the body so an attacker cannot exhaust
  // request-body parsing budget while bypassing the limiter. Two-layer
  // model: global floor (unknown-IP) + optional HMAC sub-bucket.
  const rate = await checkRateLimitKeys(request, getAnalyticsRateLimiter());
  if (!rate.allowed) {
    return NextResponse.json(
      { success: false, error: "Too many events" },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) {
    const error =
      parsed.status === 413
        ? "Payload too large"
        : parsed.status === 415
          ? "Content-Type must be application/json"
          : "Invalid request body";
    return NextResponse.json(
      { success: false, error },
      { status: parsed.status },
    );
  }

  const validation = validateAnalyticsEvent(parsed.value);
  if (!validation.success) {
    return NextResponse.json(
      { success: false, error: validation.error },
      { status: 400 },
    );
  }

  try {
    await recordAnalyticsEvent(validation.event);
    return new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    // Fixed coarse cause code only — never the raw Supabase error which may
    // contain SQL text / parameter values.
    const causeName =
      error instanceof Error ? error.name : typeof error === "string" ? error : "UnknownError";
    console.error(`ANALYTICS_EVENT_FAILED code=${causeName}`);
    return NextResponse.json(
      { success: false, error: "Service unavailable" },
      { status: 503 },
    );
  }
}

export function GET() {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405 });
}
