import { isIP } from "node:net";
import { createHmac, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ============================================================
// Trusted reverse-proxy headers
// ------------------------------------------------------------
// These headers are set by the CDN / reverse proxy in front of
// the Next.js runtime and are NOT client-forgeable in a correctly
// deployed production environment:
//
//   cf-connecting-ip     — Cloudflare
//   eo-connecting-ip     — EdgeOne (Tencent)
//   x-edgeone-client-ip  — EdgeOne (legacy alias)
//   x-real-ip            — Nginx / generic proxy
//
// `x-forwarded-for` is intentionally NOT in this list: it is a
// comma-separated chain that grows as the request traverses
// proxies, and any client can set the first hop to an arbitrary
// value. We only honor it when TRUST_X_FORWARDED_FOR=true is set
// explicitly by the operator (e.g. when running behind a known
// single-hop Nginx that overwrites the header).
// ============================================================
const TRUSTED_PROXY_HEADERS = [
  "cf-connecting-ip",
  "eo-connecting-ip",
  "x-edgeone-client-ip",
  "x-real-ip",
] as const;

function validIp(value: string | null): string | null {
  const candidate = value?.trim();
  return candidate && isIP(candidate) ? candidate : null;
}

/**
 * Return the trusted client IP, or null when no trusted header is present.
 *
 * Honors TRUST_X_FORWARDED_FOR=true to opt-in to trusting the first hop of
 * `x-forwarded-for`. This is intentionally opt-in because client-forged
 * `x-forwarded-for` values are the most common rate-limit bypass on the web.
 */
export function getClientIp(
  request: Pick<NextRequest, "headers">,
): string | null {
  for (const header of TRUSTED_PROXY_HEADERS) {
    const candidate = validIp(request.headers.get(header));
    if (candidate) return candidate;
  }
  if (process.env.TRUST_X_FORWARDED_FOR === "true") {
    const firstHop = request.headers.get("x-forwarded-for")?.split(",")[0];
    return validIp(firstHop ?? null);
  }
  return null;
}

/**
 * Compute a stable, conservative rate-limit key for the request.
 *
 * Priority:
 *   1. Trusted proxy IP header (cf-connecting-ip / eo-connecting-ip /
 *      x-edgeone-client-ip / x-real-ip) — produces `ip:<addr>`.
 *   2. x-forwarded-for first hop — ONLY when TRUST_X_FORWARDED_FOR=true.
 *   3. Stable HMAC of User-Agent + Accept-Language using a server-side
 *      secret — produces `fallback:<hmac>`. This buckets different
 *      browsers/apparent clients separately while staying stable across
 *      retries from the same client.
 *   4. If no secret is configured:
 *      - In NODE_ENV=production: a single strict `fallback:global` bucket
 *        (all unknown-IP clients share it; this is intentionally strict
 *        and is the fail-closed default).
 *      - Outside production (dev/test): `fallback:dev` (single bucket,
 *        convenient for local development).
 *
 * The previous implementation called `crypto.randomUUID()` per request
 * when no IP was available, which produced a unique key every time and
 * effectively DISABLED rate limiting for unknown-IP clients. This is the
 * bypass that this function fixes.
 *
 * The optional `randomId` parameter is retained for backward-compatibility
 * with existing tests but is no longer used in the production path. It is
 * ignored entirely.
 */
export function ephemeralRateKey(
  request: Pick<NextRequest, "headers">,
  _randomId?: () => string,
): string {
  const trustedIp = getClientIp(request);
  if (trustedIp) return `ip:${trustedIp}`;

  const secret = process.env.RATE_LIMIT_FALLBACK_SECRET;
  const userAgent = request.headers.get("user-agent") ?? "";
  const acceptLanguage = request.headers.get("accept-language") ?? "";
  // Include a coarse view of the sec-fetch-mode to differentiate fetch
  // requests from navigations without leaking PII.
  const secFetchMode = request.headers.get("sec-fetch-mode") ?? "";

  if (secret && secret.length >= 16) {
    const hmac = createHmac("sha256", secret)
      .update(`${userAgent}|${acceptLanguage}|${secFetchMode}`)
      .digest("hex");
    return `fallback:${hmac.slice(0, 16)}`;
  }

  // No secret configured.
  if (process.env.NODE_ENV === "production") {
    // Fail-safe strict: all unknown-IP clients share one bucket. This
    // prevents a single attacker from bypassing the limiter, at the cost
    // of potentially blocking legitimate unknown-IP clients when the
    // shared bucket is exhausted. Operators MUST set
    // RATE_LIMIT_FALLBACK_SECRET (>= 16 chars) in production to get
    // per-client bucketing.
    return "fallback:global";
  }
  return "fallback:dev";
}

export function isJsonRequest(request: Pick<NextRequest, "headers">): boolean {
  return (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() === "application/json"
  );
}

export function isSameOrigin(request: NextRequest): boolean {
  // Fail-closed: a missing Origin header is NOT treated as same-origin.
  // Browser fetch() always sends Origin on cross-origin and same-origin
  // credentialed requests, so a missing Origin on a state-changing request
  // is suspicious and must be rejected. Trusted non-browser callers (server
  // internal, release scripts) must use an explicit allowMissingOrigin path.
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host =
    request.headers.get("x-forwarded-host") || request.headers.get("host");
  const protocol =
    request.headers.get("x-forwarded-proto") ||
    request.nextUrl.protocol.replace(":", "");
  if (!host) return false;
  try {
    return new URL(origin).origin === `${protocol}://${host}`;
  } catch {
    return false;
  }
}

/**
 * Phase 6: Validates the Sec-Fetch-Site header for CSRF defense.
 *
 * The Sec-Fetch-Site header is automatically set by the browser and CANNOT
 * be spoofed by JavaScript. This makes it a more reliable CSRF defense than
 * the Origin header alone (which can be missing in some edge cases).
 *
 * Accepted values for state-changing requests:
 *   - "same-origin": request comes from the same origin (always safe)
 *   - "none": user-initiated navigation (e.g., typing a URL, bookmark)
 *   - missing: non-browser client (server-to-server, curl, etc.)
 *
 * Rejected values:
 *   - "cross-site": cross-origin request (CSRF risk)
 *   - "same-site": different subdomain of the same eTLD+1 (subdomain CSRF)
 *
 * @param request - The NextRequest to check
 * @returns true if the request is from a same-origin or non-browser context
 */
export function isAllowedFetchSite(request: NextRequest): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  // Missing header = non-browser client (server-to-server, curl, etc.)
  // These are allowed; authentication/authorization is handled separately.
  if (!fetchSite) return true;
  // same-origin and none are always safe for state changes
  if (fetchSite === "same-origin" || fetchSite === "none") return true;
  // cross-site and same-site are rejected for state-changing requests
  return false;
}

/**
 * Phase 6: Combined CSRF defense for state-changing endpoints.
 *
 * Checks BOTH Origin header AND Sec-Fetch-Site header. A request must pass
 * BOTH checks to be allowed:
 *   - Origin must be same-origin (or absent for non-browser clients)
 *   - Sec-Fetch-Site must be same-origin, none, or absent
 *
 * This is defense-in-depth: if one check is bypassed (e.g., a browser bug
 * that doesn't set Sec-Fetch-Site), the other still protects.
 *
 * For state-changing endpoints (POST/PUT/PATCH/DELETE) that accept browser
 * requests, use this function. For read-only endpoints, use
 * isSameOriginOrTrustedReader instead.
 *
 * @returns true if the request passes both CSRF checks
 */
export function isSameSiteRequest(request: NextRequest): boolean {
  // The Origin check fails-closed for browser requests (Origin is always
  // sent by browsers on state-changing requests). But for non-browser
  // clients (server-to-server), Origin may be missing — in that case,
  // we rely on Sec-Fetch-Site being absent too.
  const origin = request.headers.get("origin");
  const hasOrigin = Boolean(origin);

  if (hasOrigin) {
    // Browser request: Origin must match
    if (!isSameOrigin(request)) return false;
  }

  // Sec-Fetch-Site check (browser requests have this, server requests don't)
  if (!isAllowedFetchSite(request)) return false;

  // If neither header is present, it's a non-browser client — allow
  // (authentication is handled separately)
  return true;
}

/**
 * Same as {@link isSameOrigin} but permits a missing Origin header. Use ONLY
 * for read-only endpoints that must remain callable by trusted non-browser
 * clients (server-internal health checks, release-readiness scripts). Never
 * use for state-changing (POST/PATCH/DELETE) admin write endpoints.
 */
export function isSameOriginOrTrustedReader(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return isSameOrigin(request);
}

/**
 * Timing-safe comparison of two equal-length secret strings.
 * Returns false when lengths differ (callers should avoid leaking the
 * expected length by structuring the comparison as "if length differs
 * return false" before calling this).
 */
export function safeSecretEqualBuffer(
  provided: string,
  expected: string,
): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return nodeTimingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function readJsonBody<T>(
  request: NextRequest,
  maximumBytes: number,
): Promise<{ ok: true; value: T } | { ok: false; status: 400 | 413 | 415 }> {
  if (!isJsonRequest(request)) return { ok: false, status: 415 };
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    return { ok: false, status: 413 };
  }
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
      return { ok: false, status: 413 };
    }
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    return { ok: false, status: 400 };
  }
}
