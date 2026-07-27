import { isIP } from "node:net";
import { createHmac, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ============================================================
// Trusted proxy header selection
// ------------------------------------------------------------
// The operator MUST configure exactly ONE header name via the
// TRUSTED_PROXY_HEADER env var. The allowed values are a fixed
// enum matched case-insensitively:
//
//   eo-connecting-ip     — EdgeOne (Tencent)
//   x-edgeone-client-ip  — EdgeOne (legacy alias)
//   x-real-ip            — Nginx / generic proxy
//   cf-connecting-ip     — Cloudflare
//
// If TRUSTED_PROXY_HEADER is not set, is set to an unknown value,
// or the configured header is absent on the request, getClientIp
// returns null — never a fallback from a different header.
//
// x-forwarded-for is NEVER trusted automatically. It is a
// comma-separated chain that grows as the request traverses
// proxies, and any client can set the first hop to an arbitrary
// value.
// ============================================================
const ALLOWED_PROXY_HEADERS = [
  "eo-connecting-ip",
  "x-edgeone-client-ip",
  "x-real-ip",
  "cf-connecting-ip",
] as const;

const ALLOWED_PROXY_HEADER_SET: Set<string> = new Set(ALLOWED_PROXY_HEADERS);

/**
 * Minimum secret length for per-client fallback bucketing.
 * Production deployments MUST set RATE_LIMIT_FALLBACK_SECRET to at
 * least this many characters. Below this threshold the system falls
 * back to a single strict global bucket and emits a config warning.
 */
export const RATE_LIMIT_FALLBACK_SECRET_MIN_LENGTH = 32;

function validIp(value: string | null): string | null {
  const candidate = value?.trim();
  return candidate && isIP(candidate) ? candidate : null;
}

function resolveTrustedHeader(): string | null {
  const configured = (process.env.TRUSTED_PROXY_HEADER || "")
    .trim()
    .toLowerCase();
  if (!configured) return null;
  if (!ALLOWED_PROXY_HEADER_SET.has(configured)) return null;
  return configured;
}

/**
 * Return the trusted client IP from the single configured proxy header,
 * or null when the header is not configured, is invalid, or is absent.
 *
 * Only TRUSTED_PROXY_HEADER is consulted. Other proxy headers
 * (including x-forwarded-for) are NEVER checked. This prevents
 * an attacker from injecting a different header to bypass the
 * configured trust boundary.
 */
export function getClientIp(
  request: Pick<NextRequest, "headers">,
): string | null {
  const header = resolveTrustedHeader();
  if (!header) return null;
  return validIp(request.headers.get(header));
}

/**
 * Compute a stable, conservative rate-limit key for the request.
 *
 * Priority:
 *   1. The single configured TRUSTED_PROXY_HEADER — produces `ip:<addr>`.
 *   2. Stable HMAC of User-Agent + Accept-Language + Sec-Fetch-Mode
 *      using RATE_LIMIT_FALLBACK_SECRET — produces `fallback:<hmac>`.
 *      This buckets different browsers/apparent clients separately
 *      while staying stable across retries from the same client.
 *   3. If no secret is configured (or is shorter than the minimum):
 *      - In NODE_ENV=production: a single strict `fallback:global`
 *        bucket (all unknown-IP clients share it; intentionally
 *        strict, fail-closed default).
 *      - Outside production (dev/test): `fallback:dev`.
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

  if (
    secret &&
    secret.length >= RATE_LIMIT_FALLBACK_SECRET_MIN_LENGTH
  ) {
    const hmac = createHmac("sha256", secret)
      .update(`${userAgent}|${acceptLanguage}|${secFetchMode}`)
      .digest("hex");
    return `fallback:${hmac.slice(0, 16)}`;
  }

  // No secret configured (or too short).
  if (process.env.NODE_ENV === "production") {
    // Fail-safe strict: all unknown-IP clients share one bucket. This
    // prevents a single attacker from bypassing the limiter, at the cost
    // of potentially blocking legitimate unknown-IP clients when the
    // shared bucket is exhausted. Operators MUST set
    // RATE_LIMIT_FALLBACK_SECRET (>= 32 chars) in production to get
    // per-client bucketing.
    if (
      !secret ||
      secret.length < RATE_LIMIT_FALLBACK_SECRET_MIN_LENGTH
    ) {
      // Emit a fixed config warning once per process to avoid log spam.
      // This does not include the secret value or any PII.
      if (!rateLimitConfigWarned) {
        rateLimitConfigWarned = true;
        console.warn(
          "RATE_LIMIT_CONFIG_WARNING: RATE_LIMIT_FALLBACK_SECRET is missing or shorter than 32 chars; " +
            "using strict single fallback:global bucket in production. " +
            "Set RATE_LIMIT_FALLBACK_SECRET (>= 32 chars) for per-client bucketing.",
        );
      }
    }
    return "fallback:global";
  }
  return "fallback:dev";
}

let rateLimitConfigWarned = false;

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
