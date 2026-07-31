import { isIP } from "node:net";
import { createHmac, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import {
  defaultPortFor,
  getCanonicalOriginConfig,
  originsEqual,
} from "@/lib/config/canonical-origin";

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
 * Two-layer rate-limit key model for unknown-IP clients.
 *
 * When a trusted IP is available, {@link ephemeralRateKey} returns the
 * single `ip:<addr>` key. When NO trusted IP is available, the request
 * enters the "unknown source" path, which requires TWO checks:
 *
 *   1. `fallback:global` — a single strict global bucket that ALL
 *      unknown-IP clients share. This is the floor: no attacker can
 *      bypass it by rotating client-controllable headers.
 *   2. `fallback:<hmac>` (optional, only when
 *      `RATE_LIMIT_FALLBACK_SECRET` >= 32 chars is set) — a per-client
 *      sub-bucket keyed by a stable HMAC of User-Agent +
 *      Accept-Language + Sec-Fetch-Mode. This provides per-client
 *      fairness on top of the global floor.
 *
 * The caller MUST check BOTH buckets and reject when EITHER is over
 * limit. The global bucket is the security floor; the HMAC sub-bucket is
 * an additional restriction. The HMAC secret does NOT cancel the global
 * protection — even when the secret is configured, the global bucket is
 * still enforced.
 *
 * This design fixes the bypass where an attacker rotates User-Agent /
 * Accept-Language / Sec-Fetch-Mode to obtain an unlimited number of
 * unique HMAC buckets. The global bucket caps the total throughput of
 * all unknown-IP clients combined, regardless of header rotation.
 */
export interface RateLimitKeySet {
  /**
   * The keys that MUST all pass for the request to be allowed.
   * Order: global floor first (when applicable), then HMAC sub-bucket.
   * For trusted-IP requests this array has exactly one entry (`ip:<addr>`).
   * For unknown-IP requests this array has one or two entries:
   *   - Always: `fallback:global` (production) or `fallback:dev` (non-prod)
   *   - Optionally: `fallback:<hmac>` when the secret is configured
   */
  keys: readonly string[];
}

/**
 * Compute the set of rate-limit keys for the request.
 *
 * - Trusted IP available → `["ip:<addr>"]` (single check, no global floor).
 * - No trusted IP:
 *     - Production: `["fallback:global"]` (always) plus
 *       `"fallback:<hmac>"` (when secret >= 32 chars).
 *     - Non-production: `["fallback:dev"]` (always) plus
 *       `"fallback:<hmac>"` (when secret >= 32 chars).
 *
 * The global floor is ALWAYS present for unknown-IP clients. Setting
 * `RATE_LIMIT_FALLBACK_SECRET` adds a per-client sub-bucket but does NOT
 * remove the global floor — the global bucket protects against header
 * rotation regardless of secret configuration.
 *
 * The optional `randomId` parameter is retained for backward-compatibility
 * with existing tests but is no longer used in the production path.
 */
export function ephemeralRateKeySet(
  request: Pick<NextRequest, "headers">,
  _randomId?: () => string,
): RateLimitKeySet {
  const trustedIp = getClientIp(request);
  if (trustedIp) return { keys: [`ip:${trustedIp}`] };

  const keys: string[] = [];

  // Layer 1: global floor (always present for unknown-IP clients).
  if (process.env.NODE_ENV === "production") {
    keys.push("fallback:global");
    // Emit a one-time config warning when the secret is missing/short.
    const secret = process.env.RATE_LIMIT_FALLBACK_SECRET;
    if (
      (!secret || secret.length < RATE_LIMIT_FALLBACK_SECRET_MIN_LENGTH) &&
      !rateLimitConfigWarned
    ) {
      rateLimitConfigWarned = true;
      console.warn(
        "RATE_LIMIT_CONFIG_WARNING: RATE_LIMIT_FALLBACK_SECRET is missing or shorter than 32 chars; " +
          "only the strict fallback:global bucket is in effect for unknown-IP clients. " +
          "Set RATE_LIMIT_FALLBACK_SECRET (>= 32 chars) for per-client sub-bucketing on top of the global floor.",
      );
    }
  } else {
    keys.push("fallback:dev");
  }

  // Layer 2: optional HMAC sub-bucket (additional restriction, never a
  // replacement for the global floor). Only added when the secret is
  // configured and long enough — a short/missing secret means only the
  // global floor protects the endpoint, which is the strict fail-closed
  // behavior.
  const secret = process.env.RATE_LIMIT_FALLBACK_SECRET;
  if (secret && secret.length >= RATE_LIMIT_FALLBACK_SECRET_MIN_LENGTH) {
    const userAgent = request.headers.get("user-agent") ?? "";
    const acceptLanguage = request.headers.get("accept-language") ?? "";
    const secFetchMode = request.headers.get("sec-fetch-mode") ?? "";
    const hmac = createHmac("sha256", secret)
      .update(`${userAgent}|${acceptLanguage}|${secFetchMode}`)
      .digest("hex");
    keys.push(`fallback:${hmac.slice(0, 16)}`);
  }

  return { keys };
}

let rateLimitConfigWarned = false;

/**
 * Backward-compatible single-key accessor.
 *
 * Returns the FIRST key from {@link ephemeralRateKeySet}. Callers that
 * only check this single key are still protected by the global floor
 * (because it is always the first key for unknown-IP clients), but they
 * lose the additional per-client sub-bucket restriction. New call sites
 * SHOULD use {@link ephemeralRateKeySet} and check ALL keys instead.
 *
 * Existing call sites that have not yet been migrated to the two-layer
 * model continue to work — the global floor is still enforced via this
 * single key. The migration to {@link ephemeralRateKeySet} adds the
 * optional HMAC sub-bucket as an additional restriction on top.
 */
export function ephemeralRateKey(
  request: Pick<NextRequest, "headers">,
  _randomId?: () => string,
): string {
  return ephemeralRateKeySet(request, _randomId).keys[0];
}

/**
 * Check ALL rate-limit keys for a request against a single limiter.
 *
 * Returns the first over-limit result (the caller should reject with
 * 429 + Retry-After). If all keys are allowed, returns the LAST result
 * (which carries the remaining/quota for the most-restrictive bucket).
 *
 * This is the recommended call pattern for the two-layer model: the
 * global floor is checked first (security floor), and the optional HMAC
 * sub-bucket is checked second (per-client fairness). Either failing
 * rejects the request.
 */
export async function checkRateLimitKeys(
  request: Pick<NextRequest, "headers">,
  limiter: { check: (key: string) => Promise<RateLimitCheckResult> },
): Promise<RateLimitCheckResult> {
  const { keys } = ephemeralRateKeySet(request);
  let lastResult: RateLimitCheckResult = {
    allowed: true,
    remaining: Infinity,
    retryAfterSeconds: 0,
  };
  for (const key of keys) {
    const result = await limiter.check(key);
    if (!result.allowed) return result;
    lastResult = result;
  }
  return lastResult;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
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

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  // ---- KZQ-P1-012: canonical-origin path (production) ----
  // When CANONICAL_APP_ORIGIN (and optional alternates) is configured,
  // compare the browser Origin directly against the server-configured
  // canonical origin(s). The browser Origin is browser-controlled and
  // cannot be spoofed by JavaScript, so this is the strongest CSRF
  // defense. The client-injectable x-forwarded-host / host headers are
  // NOT consulted here — they are irrelevant once a canonical origin is
  // declared. A malicious x-forwarded-host cannot bypass this check
  // because it is never read in this branch.
  const canonical = getCanonicalOriginConfig();
  if (canonical.origins.length > 0) {
    return canonical.origins.some((c) => originsEqual(originUrl, c));
  }

  // ---- Dev fallback (no canonical origin configured) ----
  // Compares the browser Origin against the forwarded host. This
  // preserves localhost/dev behavior. Behind a CDN / TLS-terminating
  // proxy (EdgeOne, Cloudflare) the protocol is intentionally NOT
  // compared: x-forwarded-proto may be "http" internally while the
  // browser Origin is "https". Ports ARE normalized against the Origin
  // protocol default so that a request with a non-default explicit
  // port on one side only cannot slip through (e.g. Origin
  // "https://example.com:8080" vs host "example.com" is now rejected,
  // previously it was accepted). Production SHOULD set
  // CANONICAL_APP_ORIGIN to avoid relying on forwarded headers.
  const host =
    request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (!host) return false;

  const requestHost = host.toLowerCase();
  const originHost = originUrl.hostname.toLowerCase();
  const requestPort = requestHost.split(":")[1] || "";
  const requestHostname = requestHost.split(":")[0];

  if (requestHostname !== originHost) return false;

  const originProtocol = originUrl.protocol.toLowerCase();
  const normalizedRequestPort =
    requestPort || defaultPortFor(originProtocol);
  const normalizedOriginPort = originUrl.port || defaultPortFor(originProtocol);
  return normalizedRequestPort === normalizedOriginPort;
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
