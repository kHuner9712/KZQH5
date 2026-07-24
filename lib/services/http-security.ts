import { isIP } from "node:net";
import type { NextRequest } from "next/server";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const IP_HEADERS = [
  "cf-connecting-ip",
  "eo-connecting-ip",
  "x-edgeone-client-ip",
  "x-real-ip",
] as const;

function validIp(value: string | null): string | null {
  const candidate = value?.trim();
  return candidate && isIP(candidate) ? candidate : null;
}

export function getClientIp(
  request: Pick<NextRequest, "headers">,
): string | null {
  for (const header of IP_HEADERS) {
    const candidate = validIp(request.headers.get(header));
    if (candidate) return candidate;
  }
  return validIp(request.headers.get("x-forwarded-for")?.split(",")[0] || null);
}

export function ephemeralRateKey(
  request: Pick<NextRequest, "headers">,
  randomId: () => string = () => crypto.randomUUID(),
): string {
  return getClientIp(request) || `unknown:${randomId()}`;
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
