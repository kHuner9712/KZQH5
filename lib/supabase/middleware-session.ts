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
//   6. Response-correct — when cookies were refreshed, the function
//      returns a NEW NextResponse that:
//        a. carries `Cache-Control: private, no-store` so that any
//           shared cache can never serve a session-bound response to a
//           different user;
//        b. preserves all security headers the caller set on the
//           original response (X-Content-Type-Options, Referrer-Policy,
//           X-Frame-Options, Permissions-Policy, HSTS, CSP, etc.);
//        c. preserves any cookies the caller set on the original
//           response, in addition to the refreshed auth cookies;
//        d. forwards the updated `request.headers` (which now contains
//           the rotated auth cookies) to downstream Server Components
//           and Route Handlers via `NextResponse.next({ request })`.
//
// IMPORTANT: this module does NOT use the refreshed session for
// authorization. The middleware must NOT trust the session payload
// returned by getUser() — that would be "unverified session data" and
// is explicitly forbidden by the security constraints. The sole purpose
// of this call is to trigger the @supabase/ssr auto-refresh logic which
// rotates the access token cookie when it is close to expiry.
// ============================================================

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
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

type BufferedCookie = {
  name: string;
  value: string;
  // Options provided by @supabase/ssr (httpOnly, sameSite, secure, path,
  // maxAge). We accept `as never` at the call site because the @supabase/ssr
  // cookie option type is not strictly compatible with Next.js' cookie
  // option type (Next's type is a strict subset).
  options?: unknown;
};

/**
 * Refresh the Supabase Auth session cookies and return the final response.
 *
 * Behavior:
 *   - Creates a middleware-friendly Supabase client bound to the
 *     request's cookies.
 *   - Calls supabase.auth.getUser() which triggers @supabase/ssr's
 *     auto-refresh logic when the access token is near expiry.
 *   - When @supabase/ssr invokes the `setAll` callback to rotate any
 *     auth cookie, the new cookie is written to BOTH the request
 *     (forwarded to downstream handlers via the updated request.headers)
 *     AND a NEW NextResponse that this function returns.
 *
 * If NO auth cookie was rotated (the common case — access token still
 * valid), the function returns the `originalResponse` unchanged so the
 * caller-supplied security headers, cookies, and status are preserved
 * without any response churn.
 *
 * If at least one auth cookie was rotated:
 *   - A NEW NextResponse is built via `NextResponse.next({ request })`.
 *   - All security headers and caller-set cookies from the original
 *     response are copied onto the new response.
 *   - The buffered auth cookies are applied via `response.cookies.set`.
 *   - `Cache-Control: private, no-store` is set to forbid any shared
 *     cache from serving a session-bound response to a different user.
 *
 * Failures during `getUser()` are swallowed intentionally: the middleware
 * must not block the request if the Supabase Auth server is unreachable.
 * The downstream getVerifiedAdmin() guard will handle auth failure with
 * a redirect.
 *
 * Demo mode: when NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY
 * is missing, this function returns the `originalResponse` unchanged
 * without making any network call.
 *
 * Note on `setAll` and extra response headers:
 *   The `@supabase/ssr` `cookies.setAll` adapter only persists cookies —
 *   it does NOT emit additional HTTP response headers (verified against
 *   @supabase/ssr v0.12.x). If a future @supabase/ssr version adds
 *   response-header emission to the cookie adapter, this module must be
 *   updated to apply those headers as well. Until then there is nothing
 *   extra to forward.
 *
 * @returns The final NextResponse to return from middleware. Either the
 *          original response (Demo mode / no cookies refreshed / network
 *          failure) or a new response carrying the refreshed Set-Cookie
 *          headers and the Cache-Control: private, no-store directive.
 */
export async function refreshSupabaseSession(
  request: NextRequest,
  originalResponse: NextResponse,
): Promise<NextResponse> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Demo mode / local dev without Supabase env — return the original
  // response unchanged without making any network call.
  if (!url || !anonKey) return originalResponse;

  // Buffer the cookies that @supabase/ssr asks us to set during getUser().
  // We CANNOT apply them to a NextResponse yet because we want to build
  // that response AFTER request.headers has been mutated by setAll()
  // (so that `NextResponse.next({ request: { headers: request.headers } })`
  // captures the final, post-refresh request headers and forwards them to
  // downstream Server Components / Route Handlers).
  const pendingCookies: BufferedCookie[] = [];
  let cookiesRefreshed = false;

  const supabase = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          // 1. Forward the refreshed cookie to downstream Server Components
          //    and Route Handlers so they see the updated session. This
          //    mutates request.headers.cookie, which is captured by the
          //    NextResponse.next({ request: { headers } }) call below.
          request.cookies.set(name, value);
          // 2. Buffer the cookie — applied to the final response after
          //    getUser() returns. See comment above for why we buffer.
          pendingCookies.push({ name, value, options });
          cookiesRefreshed = true;
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
    // will redirect to login if the session is invalid. We still return
    // the original response so the caller's security headers survive.
    return originalResponse;
  }

  // Common case: no auth cookie was rotated. Return the original response
  // unchanged — preserves caller-provided security headers, cookies, and
  // status, and avoids creating a redundant NextResponse.
  if (!cookiesRefreshed) {
    return originalResponse;
  }

  // At least one auth cookie was rotated. Build a NEW NextResponse that:
  //   - forwards the mutated request.headers (now carrying the rotated
  //     auth cookies) to downstream handlers;
  //   - carries the rotated auth cookies as Set-Cookie headers;
  //   - carries `Cache-Control: private, no-store` so shared caches
  //     never serve this session-bound response to a different user;
  //   - preserves all security headers and caller-set cookies from the
  //     original response.
  const finalResponse = NextResponse.next({
    request: { headers: request.headers },
  });

  // Copy ALL non-Set-Cookie headers from the original response so the
  // caller-supplied security headers (X-Content-Type-Options, Referrer-
  // Policy, X-Frame-Options, Permissions-Policy, HSTS, CSP-Report-Only,
  // etc.) are preserved. Set-Cookie is handled separately below via the
  // cookies API so that cookie attributes (httpOnly, sameSite, secure,
  // path, maxAge) are not lost.
  originalResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    finalResponse.headers.set(key, value);
  });

  // Preserve any cookies the caller already set on the original response
  // (e.g. middleware-set cookies unrelated to Supabase auth). Using the
  // cookies API preserves cookie attributes.
  for (const cookie of originalResponse.cookies.getAll()) {
    finalResponse.cookies.set({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      maxAge: cookie.maxAge,
      path: cookie.path,
      sameSite: cookie.sameSite,
      secure: cookie.secure,
    });
  }

  // Apply the buffered refreshed auth cookies. The `options as never`
  // cast matches the existing pattern: @supabase/ssr's cookie option
  // type is a superset of Next.js' cookie option type, but the runtime
  // values are compatible.
  for (const { name, value, options } of pendingCookies) {
    finalResponse.cookies.set(name, value, options as never);
  }

  // Forbid any shared cache from serving this response. The "private"
  // token allows the browser to keep a private copy (rarely useful here
  // but harmless), "no-store" forbids any caching of the response. This
  // is REQUIRED because the response carries Set-Cookie headers that
  // bind it to a specific user's session — a cached copy served to a
  // different user would leak session cookies.
  finalResponse.headers.set("Cache-Control", "private, no-store");

  return finalResponse;
}
