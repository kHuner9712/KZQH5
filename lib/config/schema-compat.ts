// ============================================================
// Schema compatibility fallback gate (KZQ-P0-010)
// ------------------------------------------------------------
// Background:
//   `lib/repositories/inquiries.ts` (countUnreadInquiries) and
//   `lib/repositories/admin-dashboard.ts` (getSnapshot) previously
//   fell back to direct table count queries whenever a required RPC
//   was not deployed (schema/permission error). That fallback masked
//   production databases where migrations had not been fully applied,
//   leaving operators with no signal that the schema was out of
//   contract.
//
// This module centralizes the gate so both repositories, the release-
// readiness script, and tests share a single source of truth.
//
// Behavior:
//   - In production (NODE_ENV === "production"), the compatibility
//     fallback is DISABLED by default. An undeployed RPC or missing
//     permission MUST surface as a fixed error code, not a silent
//     table-query fallback.
//   - To opt IN to the fallback (Demo, local dev, or an explicitly
//     approved compatibility environment), set:
//
//       ALLOW_SCHEMA_COMPATIBILITY_FALLBACK=true
//
//     "TRUE", "True", "1", "yes" are intentionally NOT accepted.
//     The switch must be the exact string "true".
//   - In non-production (development, test, Demo), the fallback is
//     ENABLED by default so the dashboard and inquiry badge continue
//     to work against a partially-migrated local database, but can
//     still be disabled explicitly by setting the env to anything
//     other than "true".
//
// This module is a pure config reader. It does NOT import any Next.js
// runtime API and may be imported from scripts, tests, and server code.
// It must NOT be imported from client components.
// ============================================================

/** Fixed coarse cause values that may trigger the compatibility fallback. */
export type SchemaCompatCause = "schema" | "permission";

/**
 * Whether the schema-compatibility fallback is currently allowed.
 *
 * Production defaults to OFF (fail-closed); non-production defaults to ON
 * unless explicitly disabled. The explicit opt-in env var always wins.
 */
export function isSchemaCompatFallbackAllowed(): boolean {
  const explicit = process.env.ALLOW_SCHEMA_COMPATIBILITY_FALLBACK;
  if (explicit !== undefined) {
    return explicit === "true";
  }
  // Implicit default: production OFF, everything else ON.
  return process.env.NODE_ENV !== "production";
}

/**
 * Decide whether a classified failure cause should trigger the fallback.
 * Returns true ONLY when the fallback is allowed AND the cause is a
 * schema/permission mismatch (i.e. an undeployed RPC or missing grant).
 *
 * Accepts the broader `AdminDataFailureCause` string so callers can pass
 * the classifier output directly without manual narrowing. Non-schema/
 * non-permission causes always return false.
 *
 * Callers MUST use this helper instead of inline
 * `cause === "schema" || cause === "permission"` checks so the gate
 * stays in one place.
 */
export function shouldUseSchemaCompatFallback(
  cause: SchemaCompatCause | string,
): boolean {
  if (!isSchemaCompatFallbackAllowed()) return false;
  return cause === "schema" || cause === "permission";
}

/**
 * Fixed server log code emitted when a schema/permission mismatch is
 * observed but the fallback is disabled. Operators use this code to
 * correlate with the release-readiness BLOCK.
 */
export const SCHEMA_COMPAT_DISABLED_LOG_CODE = "SCHEMA_COMPAT_FALLBACK_DISABLED";

/**
 * Fixed error code returned to callers when the fallback is disabled and
 * an RPC is undeployed. Callers must map this to a coarse public error
 * (HTTP 500 / redirect cause) without leaking Supabase detail.
 */
export const SCHEMA_COMPAT_DISABLED_ERROR_CODE = "SCHEMA_COMPAT_DISABLED";
