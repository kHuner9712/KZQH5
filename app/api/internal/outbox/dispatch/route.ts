import { NextRequest, NextResponse } from "next/server";
import { processInquiryOutbox } from "@/lib/services/inquiries/outbox-processor";
import { safeSecretEqual } from "@/lib/services/timing-safe-equal";
import { readJsonBody } from "@/lib/services/http-security";

/**
 * Outbox Dispatcher — internal entrypoint.
 *
 * Canonical notification delivery path. The public inquiry submission
 * route (POST /api/inquiries) ONLY writes the inquiry + parent outbox
 * row in the same transaction; it does NOT invoke any provider. This
 * route is the single component that claims per-provider delivery rows
 * and invokes the matching adapter (Resend email / WeCom webhook).
 *
 * AUTHENTICATION CONTRACT
 *   - Server-side only. Browser Admin cookies are NEVER used — this
 *     route is intended for cron / platform workers / operators, not
 *     for authenticated browser sessions.
 *   - Authentication is a single static bearer secret:
 *       Authorization: Bearer <OUTBOX_DISPATCH_SECRET>
 *   - The secret is read from process.env.OUTBOX_DISPATCH_SECRET
 *     (NOT NEXT_PUBLIC_* — must never be exposed to the browser).
 *   - Secret missing  → 503 Service Unavailable (fail-closed: the
 *     dispatcher is intentionally disabled in this environment).
 *   - Authorization header missing  → 401 Unauthorized.
 *   - Authorization header malformed (not "Bearer <token>") → 401.
 *   - Token mismatch  → 403 Forbidden.
 *   - Timing-safe comparison mitigates side-channel token oracle.
 *
 * REQUEST CONTRACT
 *   - Content-Type: application/json
 *   - Body (optional): { "batchSize"?: number }
 *   - batchSize is clamped to [1, MAX_BATCH_SIZE]; non-integer /
 *     negative / missing defaults to DEFAULT_BATCH_SIZE.
 *   - No other fields are read.
 *
 * RESPONSE CONTRACT
 *   - 200: { "ok": true, "processed": true, "result": OutboxProcessingResult }
 *     The `result` object contains ONLY coarse-grained counters:
 *       initialized, claimed, sent, failed, deadLettered.
 *     It NEVER contains inquiry PII, provider response bodies, internal
 *     SQL errors, lock tokens, or delivery row ids.
 *   - 200: { "ok": true, "processed": false, "result": null }
 *     Returned when the dispatcher is enabled but Demo mode is active
 *     and no real providers are configured. The route still returns
 *     200 so monitoring pings don't alert, but no work is performed.
 *   - 400: invalid JSON body or batchSize outside allowed range
 *     (only after auth — see below).
 *   - 401: missing or malformed Authorization header.
 *   - 403: token mismatch.
 *   - 503: OUTBOX_DISPATCH_SECRET not configured.
 *   - 504: dispatch timeout. The route aborted the processor mid-flight;
 *     any in-flight HTTP send to a notification provider was aborted.
 *     Claimed-but-unprocessed deliveries remain 'claimed' and are
 *     re-claimed by stale recovery (default 300s).
 *   - 500: unexpected internal error. The body is a fixed string;
 *     details are logged server-side with a fixed code only.
 *
 * TIMEOUT / CANCELLATION CONTRACT (Section 11 方案 B)
 *   - The route sets up an AbortController with DISPATCH_TIMEOUT_MS.
 *   - The signal is threaded through processInquiryOutbox →
 *     NotificationSendContext.signal → NotificationRuntime.signal →
 *     postJson AbortSignal.any. A route-level timeout therefore
 *     aborts the in-flight provider HTTP request, NOT just the route.
 *   - When the timeout fires:
 *       1. The processor stops claiming NEW deliveries.
 *       2. Any in-flight adapter.send call is aborted (fetch AbortError).
 *       3. The route returns 504 with a fixed coarse body.
 *       4. The current delivery stays 'claimed'; stale recovery picks
 *          it up after staleTimeoutSeconds (default 300s).
 *   - This replaces the previous Promise.race() approach which left
 *     the processor running in the background after the route had
 *     already responded — a real bug for at-least-once delivery.
 *
 * ORDER OF CHECKS
 *   1. Secret presence (503 if missing) — checked FIRST so that
 *      unconfigured environments reject all requests without leaking
 *      whether the Authorization header was correct.
 *   2. Authorization header presence + format (401 if missing/malformed).
 *   3. Token match (403 if mismatch) — timing-safe.
 *   4. Body validation (400 if invalid).
 *   5. Dispatch with AbortController.
 *
 * DEPLOYMENT STATUS
 *   This route is implemented but NOT deployed as an always-on worker.
 *   EdgeOne does not currently provide a guaranteed long-running worker
 *   or cron mechanism. Operators may invoke this route on-demand via
 *      scripts/dispatch-inquiry-outbox.mjs
 *   or via a platform cron that supplies the bearer secret. Until a
 *   platform cron exists, dead_letter events require manual review.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

/** Fixed maximum batch size per invocation. */
const MAX_BATCH_SIZE = 50;
/** Default batch size when the caller does not supply one. */
const DEFAULT_BATCH_SIZE = 10;
/** Fixed execution timeout (ms) for the entire dispatch operation. */
const DISPATCH_TIMEOUT_MS = 30_000;

interface DispatchRequestBody {
  batchSize?: unknown;
}

interface CoarseDispatchResult {
  initialized: number;
  claimed: number;
  sent: number;
  failed: number;
  deadLettered: number;
}

function extractBearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const trimmed = header.trim();
  // Match "Bearer <token>" case-insensitively, single space only.
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(trimmed);
  return match ? match[1]! : null;
}

function coerceBatchSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_BATCH_SIZE;
  }
  const floored = Math.floor(value);
  if (floored < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(floored, MAX_BATCH_SIZE);
}

async function runDispatchWithTimeout(
  batchSize: number,
): Promise<CoarseDispatchResult> {
  // AbortController-based timeout (Section 11 方案 B).
  // The signal is threaded through processInquiryOutbox → adapter.send
  // → postJson AbortSignal.any so a timeout actually cancels the
  // in-flight HTTP send, not just the route-level await.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    DISPATCH_TIMEOUT_MS,
  );
  try {
    const result = await processInquiryOutbox(batchSize, {
      signal: controller.signal,
    });
    return {
      initialized: result.initialized,
      claimed: result.claimed,
      sent: result.sent,
      failed: result.failed,
      deadLettered: result.deadLettered,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify a thrown error from the dispatch path.
 * Returns the fixed coarse code to surface to the caller + the HTTP
 * status. NEVER returns the raw error message — only fixed codes.
 */
function classifyDispatchError(
  error: unknown,
): { code: string; status: number; logCode: string } {
  if (error instanceof Error) {
    // AbortError / DOMException.ABORT_ERR fires from controller.abort()
    // OR from the underlying fetch when the AbortSignal fires.
    const isAbort =
      error.name === "AbortError" ||
      (typeof DOMException !== "undefined" &&
        error instanceof DOMException &&
        error.name === "AbortError");
    if (isAbort) {
      return {
        code: "dispatch_timeout",
        status: 504,
        logCode: "OUTBOX_DISPATCH_TIMEOUT",
      };
    }
  }
  return {
    code: "dispatch_failed",
    status: 500,
    logCode: "OUTBOX_DISPATCH_FAILED",
  };
}

export async function POST(request: NextRequest) {
  // Step 1: Secret presence (fail-closed 503 when unconfigured).
  const secret = process.env.OUTBOX_DISPATCH_SECRET;
  if (!secret || secret.length < 16) {
    // Minimum 16 chars to discourage weak secrets in production.
    return NextResponse.json(
      { ok: false, error: "dispatcher_disabled" },
      { status: 503 },
    );
  }

  // Step 2: Authorization header presence + format.
  const token = extractBearerToken(request);
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "missing_or_malformed_authorization" },
      { status: 401 },
    );
  }

  // Step 3: Timing-safe token comparison.
  if (!safeSecretEqual(token, secret)) {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403 },
    );
  }

  // Step 4: Body validation (only after auth passes).
  const parsed = await readJsonBody<DispatchRequestBody>(request, 4 * 1024);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: "invalid_body" },
      { status: parsed.status },
    );
  }
  const batchSize = coerceBatchSize(parsed.value.batchSize);

  // Step 5: Dispatch with AbortController-driven timeout.
  try {
    const result = await runDispatchWithTimeout(batchSize);
    return NextResponse.json({
      ok: true,
      processed: true,
      result,
    });
  } catch (error) {
    // Log a fixed coarse cause only — never the raw Supabase error which
    // may contain SQL text / parameter values / PII from the inquiry.
    const classified = classifyDispatchError(error);
    console.error(`${classified.logCode}`);
    return NextResponse.json(
      { ok: false, error: classified.code },
      { status: classified.status },
    );
  }
}

export function GET() {
  return NextResponse.json(
    { ok: false, error: "Method Not Allowed" },
    { status: 405 },
  );
}
