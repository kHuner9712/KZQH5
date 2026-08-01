// ============================================================
// Work Package F: Unified public-data repository error model.
//
// Previously public repositories used three divergent contracts:
//   - swallow + return null  (lib/queries/cms.ts, lib/services/public-site.ts)
//   - swallow + return []    (lib/repositories/product-assets.ts)
//   - throw Error("PUBLIC_DATA_UNAVAILABLE", { cause })  (projects/products repos)
//
// All three conflate "DB query failed" with "legitimate empty data":
//   - null / [] could mean "no rows" OR "Supabase outage"
//   - the string-message throw gave page callers no typed boundary
//
// This module exports the canonical error class + result type that
// public repositories should use going forward:
//
//   - PublicDataUnavailableError: thrown when a REQUIRED public read
//     fails at the infrastructure layer (Supabase error, network
//     error, invalid env). Page callers catch it via renderPublicPage
//     and render the "data temporarily unavailable" fallback.
//
//   - PublicRepositoryResult<T>: optional result type for new repos
//     that prefer explicit ok/error unions over throw-based control
//     flow. Existing repos continue to throw — the result type is
//     additive and does not force a rewrite of every caller.
//
// The `code` field is a stable coarse identifier suitable for server
// logs and operational dashboards. It NEVER contains SQL, Supabase
// error text, PII, or stack information.
// ============================================================

/**
 * Stable coarse error codes for public-data reads.
 *
 * Add new codes only when a new failure mode needs to be
 * distinguishable in server logs. Re-use existing codes when the
 * failure mode is the same shape.
 */
export type PublicDataErrorCode =
  | "PUBLIC_DATA_READ_FAILED"
  | "PUBLIC_DATA_READ_EXCEPTION"
  | "PUBLIC_DATA_NOT_CONFIGURED";

/**
 * Page-level error: a required public read failed.
 *
 * Page callers should NOT inspect `cause` — it carries the original
 * Supabase error for debugging only and is NEVER serialized into the
 * HTTP response or logged verbatim. Use `code` for log/dashboard
 * classification.
 *
 * Throwing this error signals to `renderPublicPage` that the failure
 * is a known, operational, recoverable data-availability issue and
 * the "data temporarily unavailable" fallback should be rendered.
 *
 * Other errors (React render errors, programming bugs, thrown
 * primitives) MUST bubble past `renderPublicPage` to the route
 * error boundary (`app/(public)/error.tsx`) so they are not silently
 * hidden behind the friendly "try again later" UI.
 */
export class PublicDataUnavailableError extends Error {
  readonly code: PublicDataErrorCode;

  constructor(
    code: PublicDataErrorCode = "PUBLIC_DATA_READ_FAILED",
    options?: { cause?: unknown },
  ) {
    super(`PublicDataUnavailableError:${code}`);
    this.name = "PublicDataUnavailableError";
    this.code = code;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  /**
   * True when `value` was thrown by a public repository. Use this
   * helper in catch blocks instead of `instanceof` when the
   * PublicDataUnavailableError class may live in a different module
   * realm (rare, but defensive).
   */
  static is(value: unknown): value is PublicDataUnavailableError {
    return (
      value instanceof Error &&
      value.name === "PublicDataUnavailableError"
    );
  }
}

/**
 * Optional result type for public repositories that prefer explicit
 * ok/error unions over throw-based control flow.
 *
 * Throwing PublicDataUnavailableError remains the canonical pattern
 * for REQUIRED reads — page renderers cannot proceed without the
 * data, so propagation to the page boundary is correct.
 *
 * The result type is appropriate for OPTIONAL reads (e.g. a sidebar
 * widget that can degrade gracefully) where callers want to branch
 * on failure without try/catch.
 */
export type PublicRepositoryResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: PublicDataErrorCode };

/**
 * Helper for repositories that want to log a fixed coarse code on
 * infrastructure failure without leaking raw Supabase error text.
 *
 * The original error is preserved as `cause` on the thrown
 * PublicDataUnavailableError for debugging — it is NOT logged here.
 */
export function logPublicDataFailure(
  code: PublicDataErrorCode,
  cause?: unknown,
): void {
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    // Only emit the fixed coarse code. Do NOT log cause.message, cause.code,
    // cause.details, or any PII — they may contain schema or stack info.
    console.warn(code);
  }
  void cause; // cause is preserved on the thrown error, not logged here.
}

/**
 * Backwards-compat: the legacy string-message throw used
 * "PUBLIC_DATA_UNAVAILABLE" as Error.message. This constant keeps
 * the literal in one place for any code paths that still inspect
 * message strings (none in this codebase after Work Package F, but
 * kept defensive in case of untracked callers).
 */
export const LEGACY_PUBLIC_DATA_UNAVAILABLE_MESSAGE =
  "PUBLIC_DATA_UNAVAILABLE";
