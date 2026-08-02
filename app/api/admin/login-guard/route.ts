import { NextResponse, type NextRequest } from "next/server";
import { getLoginRateLimiter } from "@/lib/services/rate-limit";
import { checkRateLimitKeys } from "@/lib/services/http-security";
import { LOGIN_ERROR_MESSAGES } from "@/lib/security/login-errors";

// ============================================================
// KZQ-P1-021: Admin login brute-force protection — server guard
// ------------------------------------------------------------
// The login form calls this endpoint (POST, no body — credentials are
// NEVER sent here) BEFORE attempting `supabase.auth.signInWithPassword`.
// The server counts attempts and makes the over-limit decision — the
// client never performs its own counting.
//
// Security properties:
//   - No credentials, tokens or PII are accepted or logged. The
//     request body is ignored entirely.
//   - Over-limit → 429 with the fixed Chinese rate-limit message
//     (KZQ-P1-020 whitelist) + Retry-After + Cache-Control: no-store.
//   - Only a coarse fixed code is logged (no email, no IP, no vendor
//     error detail).
//
// Boundary (honest): this guard gates the APPLICATION login flow only.
// A client that bypasses the form and calls Supabase Auth directly is
// not stopped here — the real floor is Supabase Auth's built-in login
// rate limiting (per-IP + per-email, configured in the Auth dashboard)
// plus an EdgeOne WAF rule on this endpoint (see
// docs/EDGEONE_WAF_RULES.md §2.12 and §8).
// ============================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // Body is intentionally ignored — never accept/parse credentials here.
  const rate = await checkRateLimitKeys(request, getLoginRateLimiter());
  if (!rate.allowed) {
    console.warn("ADMIN_LOGIN_RATE_LIMITED");
    return NextResponse.json(
      { ok: false, error: LOGIN_ERROR_MESSAGES.RATE_LIMITED },
      {
        status: 429,
        headers: {
          "Retry-After": String(rate.retryAfterSeconds),
          "Cache-Control": "no-store",
        },
      },
    );
  }
  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
