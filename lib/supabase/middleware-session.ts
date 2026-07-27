// ============================================================
// Supabase Auth Session Refresh — Middleware Helper
// ------------------------------------------------------------
// This module is the ONLY place where Supabase Auth session cookies
// are touched inside middleware. It is designed to be:
//
//   1. Compatible with @supabase/ssr v0.12.x and Next.js 15 middleware.
//   2. Safe for ISR — the caller decides WHICH paths trigger a refresh,
//      so public ISR pages are never forced into dynamic rendering.
//   3. Fail-open for the refresh itself — a network failure during
//      refresh does NOT block the request. Authorization is enforced
//      server-side by getVerifiedAdmin() which calls auth.getUser()
//      again with verified cookies. This module only refreshes cookies;
//      it does NOT authorize.
//   4. Demo-mode aware — when NEXT_PUBLIC_SUPABASE_URL or anon key is
//      missing, the refresh is skipped silently.
//   5. Cookie-correct — refreshed cookies are written back to BOTH the
//      incoming request (so downstream Server Components see the new
//      session) and the outgoing response (so the browser persists them).
//
// IMPORTANT: this module does NOT use the refreshed session for
// authorization. The middleware must NOT trust the session payload
// returned by getUser() — that would be "unverified session data" and
// is explicitly forbidden by the security constraints. The sole purpose
// of this call is to trigger the @supabase/ssr auto-refresh logic which
// rotates the access token cookie when it is close to expiry.
// ============================================================

import { createServerClient } from "@supabase/ssr";
import type { NextRequest } from "next/server";
import type { NextResponse } from "next/server";
import type { Database } from "@/types/database";

/**
 * Paths whose requests should trigger a Supabase session refresh in
 * middleware. Keep this list TIGHT — every path here means a network
 * round-trip to the Supabase Auth server on every request to that path.
 *
 * Public ISR pages are intentionally NOT in this list: reading auth
 * cookies there would force dynamic rendering and break ISR.
 */
export const SESSION_REFRESH_PATHS = [
  "/admin",
  "/api/admin",
  "/api/internal",
] as const;

export function shouldRefreshSession(pathname: string): boolean {
  return SESSION_REFRESH_PATHS.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Refresh the Supabase Auth session cookies on the request and response.
 *
 * This function:
 *   - Creates a middleware-friendly Supabase client bound to the
 *     request's cookies.
 *   - Calls supabase.auth.getUser() which triggers @supabase/ssr's
 *     auto-refresh logic when the access token is near expiry.
 *   - Writes any refreshed cookies back to BOTH the request (forwarded
 *     to downstream handlers) and the response (persisted by the browser).
 *
 * Failures are swallowed intentionally: the middleware must not block
 * the request if the Supabase Auth server is unreachable. The downstream
 * getVerifiedAdmin() guard will handle auth failure with a redirect.
 *
 * Demo mode: when NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY
 * is missing, this function returns immediately without making any
 * network call.
 */
export async function refreshSupabaseSession(
  request: NextRequest,
  response: NextResponse,
): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return;

  const supabase = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          // 1. Forward the refreshed cookie to downstream Server Components
          //    and Route Handlers so they see the updated session.
          request.cookies.set(name, value);
          // 2. Persist the refreshed cookie on the outgoing response so
          //    the browser stores it. The options (httpOnly, sameSite,
          //    secure, path, maxAge) are provided by @supabase/ssr.
          response.cookies.set(name, value, options as never);
        }
      },
    },
  });

  // getUser() validates the JWT with the Supabase Auth server and, if the
  // access token is expired but the refresh token is valid, silently
  // rotates the session. The setAll callback above persists the rotated
  // cookies. We intentionally do NOT use the returned user object for
  // authorization — that is the exclusive job of getVerifiedAdmin() on
  // the server side.
  try {
    await supabase.auth.getUser();
  } catch {
    // Network failure during refresh — do not block. Downstream guard
    // will redirect to login if the session is invalid.
  }
}
