// ============================================================
// Canonical application origin configuration (KZQ-P1-012)
// ------------------------------------------------------------
// Server-side only. NEVER add a NEXT_PUBLIC_ prefix — this module
// reads server secrets/config and must not be bundled into client
// components. It has NO dependency on the Next.js runtime (no
// headers/cookies/NextRequest), so it can be imported by edge
// middleware, route handlers, release-readiness scripts and unit
// tests alike.
//
// Why a server-configured canonical origin is needed:
//   The previous isSameOrigin (lib/services/http-security.ts)
//   compared the browser Origin header against the request
//   Host / x-forwarded-host. Those headers are client-injectable
//   when the request is not behind a trusted proxy that strips
//   and overwrites them, so an attacker could craft a request
//   whose x-forwarded-host matches their malicious Origin and
//   bypass the CSRF check. Comparing the browser Origin (which is
//   browser-controlled and cannot be spoofed by JavaScript) against
//   a server-configured canonical origin removes that trust
//   dependency entirely — the forwarded host is no longer consulted
//   once a canonical origin is configured.
//
// Environment variables (both optional; production SHOULD set
// CANONICAL_APP_ORIGIN):
//
//   CANONICAL_APP_ORIGIN
//     Primary canonical origin, e.g. "https://kzq.example.com".
//     The browser Origin must match this (or an alternate) for
//     same-origin CSRF validation.
//
//   CANONICAL_APP_ORIGIN_ALTERNATES
//     Comma-separated additional allowed origins, e.g. a staging
//     domain or a legacy "www" variant:
//       https://www.kzq.example.com,https://staging.kzq.example.com
//
// Accepted format: "<scheme>://<hostname>[:<port>]" with an optional
// trailing path / search / hash (stripped). Only "http:" and "https:"
// schemes are accepted; any other scheme (ftp:, ws:, etc.) is rejected
// and silently dropped from the list. Invalid entries do NOT raise —
// a single typo in the alternates list must not break CSRF checks;
// the operator is alerted via a one-time production warning when the
// PRIMARY origin was set but produced zero valid origins.
// ============================================================

/**
 * A parsed, normalized canonical origin.
 *
 * All fields are lowercased and the port is resolved to the protocol
 * default when not explicitly given (https -> "443", http -> "80"),
 * so two origins that differ only by an explicit-vs-implicit default
 * port compare equal.
 */
export interface CanonicalOrigin {
  /** Lowercased scheme including the colon, e.g. "https:". */
  readonly protocol: string;
  /** Lowercased hostname, e.g. "kzq.example.com". */
  readonly hostname: string;
  /** Resolved port as a string: "443"/"80" for the protocol default,
   * or an explicit port like "8443". */
  readonly port: string;
  /** Display string without a redundant default port,
   * e.g. "https://kzq.example.com" or "https://kzq.example.com:8443". */
  readonly display: string;
}

/**
 * Resolved canonical-origin configuration.
 */
export interface CanonicalOriginConfig {
  /** Valid parsed origins (primary first, then alternates). */
  readonly origins: readonly CanonicalOrigin[];
  /**
   * True when CANONICAL_APP_ORIGIN was non-empty, regardless of
   * whether it parsed to a valid origin. Used to distinguish
   * "not configured" (dev fallback) from "configured but malformed"
   * (operator misconfiguration).
   */
  readonly configured: boolean;
}

/**
 * Resolve the default port string for a URL protocol. Returns "" for
 * unknown protocols (which are rejected upstream anyway).
 */
export function defaultPortFor(protocol: string): string {
  const p = protocol.toLowerCase();
  if (p === "https:") return "443";
  if (p === "http:") return "80";
  return "";
}

/**
 * Normalize a raw port string against a protocol: returns the explicit
 * port (lowercased) when present, otherwise the protocol default.
 */
export function normalizePort(port: string, protocol: string): string {
  if (port) return port.toLowerCase();
  return defaultPortFor(protocol.toLowerCase());
}

function parseCanonicalOrigin(raw: string): CanonicalOrigin | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return null;

  const hostname = url.hostname.toLowerCase();
  if (!hostname) return null;

  const port = normalizePort(url.port, protocol);
  const defaultPort = defaultPortFor(protocol);
  const display =
    port === defaultPort
      ? `${protocol}//${hostname}`
      : `${protocol}//${hostname}:${port}`;

  return { protocol, hostname, port, display };
}

let canonicalMisconfigWarned = false;

/**
 * Read and parse the canonical origins from environment variables.
 *
 * Reads `process.env` on every call (no module-level caching) so
 * tests can flip the configuration between cases without resetting a
 * cache. The cost of parsing a handful of URLs per request is
 * negligible compared to the auth/RPC work that follows.
 *
 * Returns the primary origin first (when valid), followed by valid
 * alternates. Invalid primary entries trigger a one-time production
 * warning so a typo does not silently weaken CSRF defense.
 */
export function getCanonicalOriginConfig(): CanonicalOriginConfig {
  const primary = (process.env.CANONICAL_APP_ORIGIN ?? "").trim();
  const configured = primary.length > 0;
  const origins: CanonicalOrigin[] = [];

  let primaryValid = false;
  if (configured) {
    const parsed = parseCanonicalOrigin(primary);
    if (parsed) {
      origins.push(parsed);
      primaryValid = true;
    }
  }

  const alternates = (process.env.CANONICAL_APP_ORIGIN_ALTERNATES ?? "").trim();
  if (alternates) {
    for (const candidate of alternates.split(",")) {
      const parsed = parseCanonicalOrigin(candidate);
      if (parsed) origins.push(parsed);
    }
  }

  if (
    configured &&
    !primaryValid &&
    process.env.NODE_ENV === "production" &&
    !canonicalMisconfigWarned
  ) {
    canonicalMisconfigWarned = true;
    console.warn(
      "CANONICAL_ORIGIN_CONFIG_WARNING: CANONICAL_APP_ORIGIN is set but could not be parsed into a valid http(s) origin. " +
        "isSameOrigin will fall back to the weaker forwarded-host comparison. " +
        "Fix CANONICAL_APP_ORIGIN (format: https://example.com) to restore strict canonical-origin CSRF validation.",
    );
  }

  return { origins, configured };
}

/**
 * True when at least one valid canonical origin is configured. When
 * false, isSameOrigin falls back to the legacy forwarded-host
 * comparison (dev/localhost only — production SHOULD configure a
 * canonical origin).
 */
export function isCanonicalOriginConfigured(): boolean {
  return getCanonicalOriginConfig().origins.length > 0;
}

/**
 * Strict equality between a parsed browser Origin URL and a canonical
 * origin. Compares protocol, hostname (case-insensitive) and the
 * normalized port. Used by isSameOrigin when a canonical origin is
 * configured.
 */
export function originsEqual(
  originUrl: URL,
  canonical: CanonicalOrigin,
): boolean {
  return (
    originUrl.protocol.toLowerCase() === canonical.protocol &&
    originUrl.hostname.toLowerCase() === canonical.hostname &&
    normalizePort(originUrl.port, originUrl.protocol) === canonical.port
  );
}
