// ============================================================
// Supabase Auth Session Refresh — Edge-Compatible Middleware Helper
// ------------------------------------------------------------
// This module is the ONLY place where Supabase Auth session cookies
// are touched inside middleware. It is designed to be:
//
//   1. Edge Runtime compatible — does NOT import @supabase/ssr or
//      @supabase/supabase-js, which both pull in `process.version`
//      (a Node.js-only API). This avoids the Vercel/EdgeOne build
//      warning: "A Node.js module is loaded (@supabase/supabase-js
//      uses process.version), which is unsupported in Edge Runtime."
//      Instead, this module uses only Web APIs (fetch, Headers,
//      TextEncoder, TextDecoder, atob, btoa) that are available in
//      BOTH the Edge Runtime and Node.js.
//   2. Safe for ISR — the caller decides WHICH paths trigger a
//      refresh, so public ISR pages are never forced into dynamic
//      rendering.
//   3. Fail-open for the refresh itself — a network failure during
//      refresh does NOT block the request. Authorization is enforced
//      server-side by getVerifiedAdmin() which calls auth.getUser()
//      again with verified cookies. This module only refreshes
//      cookies; it does NOT authorize.
//   4. Demo-mode aware — when NEXT_PUBLIC_SUPABASE_URL or anon key
//      is missing, the refresh is skipped silently.
//   5. Cookie-correct — refreshed cookies are written back to BOTH
//      the incoming request (so downstream Server Components see the
//      new session) and the outgoing response (so the browser
//      persists them).
//   6. Response-correct — when cookies were refreshed, the function
//      returns a NEW NextResponse that:
//        a. carries `Cache-Control: private, no-store` so that any
//           shared cache can never serve a session-bound response
//           to a different user;
//        b. preserves all security headers the caller set on the
//           original response (X-Content-Type-Options, Referrer-
//           Policy, X-Frame-Options, Permissions-Policy, HSTS,
//           CSP, etc.);
//        c. preserves any cookies the caller set on the original
//           response, in addition to the refreshed auth cookies;
//        d. forwards the updated `request.headers` (which now
//           contains the rotated auth cookies) to downstream
//           Server Components and Route Handlers via
//           `NextResponse.next({ request })`.
//
// IMPORTANT: this module does NOT use the refreshed session for
// authorization. The middleware must NOT trust the session payload
// returned by the refresh call — that would be "unverified session
// data" and is explicitly forbidden by the security constraints.
// The sole purpose of the refresh is to rotate the access token
// cookie when it is close to expiry.
//
// Cookie format (compatible with @supabase/ssr v0.12.x):
//   - Cookie name: sb-<project-ref>-auth-token
//   - If the value exceeds MAX_CHUNK_SIZE (3180 bytes), it is split
//     into chunks: sb-<project-ref>-auth-token.0, .1, ...
//   - The value is prefixed with "base64-" and then base64url-encoded
//     (the default cookieEncoding for @supabase/ssr).
//   - The decoded value is a JSON string containing the session
//     object: { access_token, refresh_token, expires_at, ... }
// ============================================================

import { NextResponse, type NextRequest } from "next/server";

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

// --- Constants (mirrors @supabase/ssr internals) -----------------------

/**
 * Maximum cookie chunk size. Mirrors @supabase/ssr's MAX_CHUNK_SIZE
 * so that cookies written by this module are compatible with cookies
 * written by @supabase/ssr in Route Handlers and Server Components.
 */
const MAX_CHUNK_SIZE = 3180;

/**
 * The base64 prefix used by @supabase/ssr when cookieEncoding is
 * "base64url" (the default). Values written by @supabase/ssr look
 * like: "base64-<base64url-encoded-json>".
 */
const BASE64_PREFIX = "base64-";

/**
 * Default cookie options matching @supabase/ssr's DEFAULT_COOKIE_OPTIONS.
 * These MUST stay in sync so that cookies written here are
 * indistinguishable from cookies written by @supabase/ssr.
 */
const DEFAULT_COOKIE_OPTIONS = {
  path: "/",
  sameSite: "lax" as const,
  httpOnly: false,
  maxAge: 400 * 24 * 60 * 60, // 400 days
};

/**
 * Refresh the token when it expires within this many seconds.
 * Mirrors supabase-js's default auto-refresh threshold.
 */
const REFRESH_THRESHOLD_SECONDS = 60;

// --- base64url helpers (Edge Runtime compatible) -----------------------

/**
 * Encode a string to base64url. Uses TextEncoder + btoa which are
 * available in both Edge Runtime and Node.js.
 */
function stringToBase64URL(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode a base64url string to a string. Uses atob + TextDecoder
 * which are available in both Edge Runtime and Node.js.
 */
function stringFromBase64URL(str: string): string {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// --- Cookie chunking (mirrors @supabase/ssr's chunker) -----------------

/**
 * Check if a cookie name is the base key or a chunk of it.
 * Matches: key, key.0, key.1, etc.
 */
function isChunkLike(cookieName: string, key: string): boolean {
  if (cookieName === key) return true;
  const match = cookieName.match(/^(.*)[.](0|[1-9][0-9]*)$/);
  return !!match && match[1] === key;
}

/**
 * Split a value into chunks that fit within MAX_COOKIE_SIZE.
 * Each chunk is a { name, value } pair. The first chunk uses the
 * base key name; subsequent chunks use key.0, key.1, etc.
 *
 * This mirrors @supabase/ssr's createChunks, including the
 * encodeURIComponent / decodeURIComponent boundary handling.
 */
function createChunks(key: string, value: string): Array<{ name: string; value: string }> {
  const encodedValue = encodeURIComponent(value);
  if (encodedValue.length <= MAX_CHUNK_SIZE) {
    return [{ name: key, value }];
  }

  const chunks: string[] = [];
  let remaining = encodedValue;
  while (remaining.length > 0) {
    let head = remaining.slice(0, MAX_CHUNK_SIZE);
    // Check if the last escaped character is truncated.
    const lastEscapePos = head.lastIndexOf("%");
    if (lastEscapePos > MAX_CHUNK_SIZE - 3) {
      head = head.slice(0, lastEscapePos);
    }
    // Check if the chunk was split along a valid unicode boundary.
    while (head.length > 0) {
      try {
        decodeURIComponent(head);
        break;
      } catch (error) {
        if (error instanceof URIError && head.at(-3) === "%" && head.length > 3) {
          head = head.slice(0, head.length - 3);
        } else {
          throw error;
        }
      }
    }
    chunks.push(decodeURIComponent(head));
    remaining = remaining.slice(head.length);
  }
  return chunks.map((v, i) => ({ name: `${key}.${i}`, value: v }));
}

/**
 * Read and combine chunked cookies from a NextRequest.
 * Returns the combined raw cookie value, or null if not present.
 */
function readChunkedCookie(request: NextRequest, key: string): string | null {
  // Try the unchunked form first (common case — session fits in one cookie).
  const direct = request.cookies.get(key)?.value;
  if (direct) return direct;

  // Fall back to chunked form: key.0, key.1, ...
  const chunks: string[] = [];
  for (let i = 0; ; i++) {
    const chunkName = `${key}.${i}`;
    const chunk = request.cookies.get(chunkName)?.value;
    if (!chunk) break;
    chunks.push(chunk);
  }
  return chunks.length > 0 ? chunks.join("") : null;
}

// --- Session parsing ---------------------------------------------------

interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  user?: unknown;
}

/**
 * Decode a raw cookie value (which may be base64-prefixed) into a
 * session object. Returns null if the value cannot be decoded.
 *
 * This mirrors @supabase/ssr's decodeChunkedCookieValue logic.
 */
function decodeSession(rawValue: string): SupabaseSession | null {
  let jsonStr: string;
  if (rawValue.startsWith(BASE64_PREFIX)) {
    try {
      jsonStr = stringFromBase64URL(rawValue.substring(BASE64_PREFIX.length));
    } catch {
      // Corrupted base64 — treat as absent.
      return null;
    }
    try {
      JSON.parse(jsonStr); // validate JSON
    } catch {
      return null;
    }
  } else {
    jsonStr = rawValue;
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.access_token === "string" &&
      typeof parsed.refresh_token === "string"
    ) {
      return parsed as SupabaseSession;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Encode a session object into a raw cookie value (base64-prefixed).
 */
function encodeSession(session: SupabaseSession): string {
  const jsonStr = JSON.stringify(session);
  return BASE64_PREFIX + stringToBase64URL(jsonStr);
}

// --- Project ref derivation -------------------------------------------

/**
 * Extract the 20-character project ref from the Supabase URL.
 * Returns null if the URL doesn't match the canonical Supabase project
 * host pattern.
 */
function getProjectRef(supabaseUrl: string): string | null {
  try {
    const host = new URL(supabaseUrl).hostname.toLowerCase();
    const match = host.match(/^([a-z0-9]{20})\.supabase\.co$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// --- Refresh API call -------------------------------------------------

/**
 * Call the Supabase Auth refresh-token endpoint.
 *
 * POST to {supabaseUrl}/auth/v1/token?grant_type=refresh_token with
 * the refresh token. Returns the new session or throws on failure.
 */
async function callRefreshToken(
  supabaseUrl: string,
  anonKey: string,
  refreshToken: string,
  accessToken: string,
): Promise<SupabaseSession> {
  const res = await fetch(
    `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(8_000),
    },
  );

  if (!res.ok) {
    throw new Error(`REFRESH_HTTP_${res.status}`);
  }

  const body = await res.json();
  if (
    typeof body !== "object" ||
    body === null ||
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string"
  ) {
    throw new Error("REFRESH_MALFORMED");
  }

  return body as SupabaseSession;
}

// --- Main entry point -------------------------------------------------

/**
 * Refresh the Supabase Auth session cookies and return the final response.
 *
 * Behavior:
 *   - Reads the Supabase auth cookie (chunked, base64-encoded) from
 *     the request.
 *   - Checks if the access token is near expiry (within
 *     REFRESH_THRESHOLD_SECONDS).
 *   - If refresh is needed, calls the Supabase Auth refresh-token
 *     endpoint directly via fetch() (no @supabase/ssr dependency).
 *   - When the session is refreshed, the new cookie is written to
 *     BOTH the request (forwarded to downstream handlers via the
 *     updated request.headers) AND a NEW NextResponse that this
 *     function returns.
 *
 * If NO auth cookie was rotated (the common case — access token still
 * valid, or no session cookie present), the function returns the
 * `originalResponse` unchanged so the caller-supplied security
 * headers, cookies, and status are preserved without any response
 * churn.
 *
 * If the session was refreshed:
 *   - A NEW NextResponse is built via `NextResponse.next({ request })`.
 *   - All security headers and caller-set cookies from the original
 *     response are copied onto the new response.
 *   - The refreshed auth cookie chunks are applied via
 *     `response.cookies.set`.
 *   - `Cache-Control: private, no-store` is set to forbid any shared
 *     cache from serving a session-bound response to a different user.
 *
 * Failures during refresh are swallowed intentionally: the middleware
 * must not block the request if the Supabase Auth server is unreachable.
 * The downstream getVerifiedAdmin() guard will handle auth failure with
 * a redirect.
 *
 * Demo mode: when NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY
 * is missing, this function returns the `originalResponse` unchanged
 * without making any network call.
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

  // Derive the auth cookie name from the Supabase URL.
  // If the URL is non-canonical (e.g. localhost mock), skip refresh.
  const projectRef = getProjectRef(url);
  if (!projectRef) return originalResponse;

  const cookieName = `sb-${projectRef}-auth-token`;

  // Read the current session from cookies.
  const rawValue = readChunkedCookie(request, cookieName);
  if (!rawValue) {
    // No session cookie present — nothing to refresh.
    return originalResponse;
  }

  const session = decodeSession(rawValue);
  if (!session) {
    // Corrupted session cookie — skip refresh; downstream guard will
    // handle the invalid session.
    return originalResponse;
  }

  // Check if the access token is near expiry.
  const now = Math.floor(Date.now() / 1000);
  const expiresAt =
    typeof session.expires_at === "number"
      ? session.expires_at
      : typeof session.expires_in === "number"
        ? now + session.expires_in
        : null;

  // If we can't determine expiry, or the token is still valid, skip refresh.
  if (expiresAt === null || expiresAt - now > REFRESH_THRESHOLD_SECONDS) {
    return originalResponse;
  }

  // Attempt to refresh the token.
  let newSession: SupabaseSession;
  try {
    newSession = await callRefreshToken(
      url,
      anonKey,
      session.refresh_token,
      session.access_token,
    );
  } catch {
    // Network failure / HTTP error / malformed response — do not
    // block. Downstream guard will redirect to login if the session
    // is invalid. Return the original response so the caller's
    // security headers survive the network failure.
    return originalResponse;
  }

  // --- Session was refreshed. Build the new cookie value. ---
  const encodedValue = encodeSession(newSession);
  const chunks = createChunks(cookieName, encodedValue);

  // 1. Forward the refreshed cookie chunks to downstream Server
  //    Components and Route Handlers by mutating request.cookies.
  //    Remove old chunks first, then set new ones.
  //    We need to clear ALL old chunk cookies to avoid stale chunks.
  const allCookies = request.cookies.getAll();
  for (const cookie of allCookies) {
    if (isChunkLike(cookie.name, cookieName)) {
      request.cookies.delete(cookie.name);
    }
  }
  for (const { name, value } of chunks) {
    request.cookies.set(name, value);
  }

  // 2. Build a NEW NextResponse that:
  //    - forwards the mutated request.headers (now carrying the rotated
  //      auth cookies) to downstream handlers;
  //    - carries the rotated auth cookies as Set-Cookie headers;
  //    - carries `Cache-Control: private, no-store` so shared caches
  //      never serve this session-bound response to a different user;
  //    - preserves all security headers and caller-set cookies from
  //      the original response.
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

  // Apply the refreshed auth cookie chunks. Each chunk is set with
  // the same default cookie options that @supabase/ssr uses so that
  // cookies written here are compatible with cookies written by
  // @supabase/ssr in Route Handlers and Server Components.
  for (const { name, value } of chunks) {
    finalResponse.cookies.set(name, value, {
      ...DEFAULT_COOKIE_OPTIONS,
    });
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
