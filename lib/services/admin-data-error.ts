/**
 * Safe classifier for protected admin data-read failures.
 *
 * This module NEVER inspects, records, or returns sensitive error payload:
 *   - message
 *   - details
 *   - hint
 *   - stack
 *   - URL
 *   - Headers
 *   - Cookies
 *   - Tokens
 *   - user IDs
 *   - emails
 *   - data rows
 *
 * Classification reads only:
 *   - error.code (string | number | undefined)
 *   - error.name (string | undefined)
 *
 * The output is a fixed enum-like string, safe to emit to server logs and to
 * propagate through redirect query params.
 *
 * Contract:
 *   - classifyAdminDataError NEVER throws. Any input (including getters that
 *     throw, non-string/non-number codes, null, undefined, primitives) is
 *     normalized to a fixed cause.
 *   - Only string and number codes/names are inspected. Anything else is
 *     treated as an empty string.
 */

export type AdminDataFailureCause =
  | "schema"
  | "permission"
  | "authentication"
  | "connection"
  | "timeout"
  | "count-unavailable"
  | "unknown";

/**
 * Full set of allowed cause values. Used by callers to normalize unknown
 * strings into "unknown" and to type-narrow redirect parameters.
 */
export const ADMIN_DATA_FAILURE_CAUSES: readonly AdminDataFailureCause[] = [
  "schema",
  "permission",
  "authentication",
  "connection",
  "timeout",
  "count-unavailable",
  "unknown",
] as const;

/**
 * Fixed server log code per cause. Callers MUST only call console.warn with
 * this single string argument — no second argument, no error object, no stack.
 */
export const ADMIN_DATA_LOG_CODE: Readonly<Record<AdminDataFailureCause, string>> =
  Object.freeze({
    schema: "ADMIN_GUARD_DATA_SCHEMA",
    permission: "ADMIN_GUARD_DATA_PERMISSION",
    authentication: "ADMIN_GUARD_DATA_AUTHENTICATION",
    connection: "ADMIN_GUARD_DATA_CONNECTION",
    timeout: "ADMIN_GUARD_DATA_TIMEOUT",
    "count-unavailable": "ADMIN_GUARD_DATA_COUNT_UNAVAILABLE",
    unknown: "ADMIN_GUARD_DATA_UNKNOWN",
  });

/**
 * Supabase/PostgREST SQLSTATE codes and PGRST error codes mapped to causes.
 * Matched by exact string equality after uppercasing. No regex on message.
 */
const SCHEMA_CODES: ReadonlySet<string> = new Set([
  "42703", // undefined_column
  "42P01", // undefined_table
  "PGRST200", // schemaCacheMiss
  "PGRST202", // schemaCacheMiss
  "PGRST204", // no schema loaded for relation
  "PGRST205", // no schema loaded for rpc
]);

const PERMISSION_CODES: ReadonlySet<string> = new Set([
  "42501", // insufficient_privilege
]);

const AUTHENTICATION_CODES: ReadonlySet<string> = new Set([
  "28000", // invalid_authorization_specification
  "28P01", // invalid_password
  "PGRST300", // unauthorized
  "PGRST301", // not found (auth)
  "PGRST302", // jwt expired
  "PGRST303", // jwt invalid
]);

const CONNECTION_CODES: ReadonlySet<string> = new Set([
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "PGRST000",
  "PGRST001",
  "PGRST002",
  "PGRSTX00",
]);

const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "57014", // query_canceled
  "PGRST003", // timeout
]);

const TIMEOUT_NAMES: ReadonlySet<string> = new Set([
  "AbortError",
  "TimeoutError",
]);

/**
 * Safely read a property from an object without throwing. If the property
 * accessor throws, or the value is not a string or number, returns "".
 *
 * Only string and number are accepted. Booleans, objects, symbols, etc.
 * are treated as empty — we never call String(value) on them, which could
 * invoke unexpected toString() implementations or getters.
 */
function safeReadKey(obj: object, key: string): string {
  try {
    const value = (obj as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    return "";
  } catch {
    return "";
  }
}

/**
 * Inspect an unknown error-like value and return a fixed cause.
 *
 * Only reads `code` and `name` from the error. Falls through to "unknown"
 * for anything that doesn't match a known code/name. NEVER throws.
 *
 * Judgment order:
 *   1. schema exact codes
 *   2. permission exact codes OR 0L/0P SQLSTATE class prefix
 *   3. authentication exact codes
 *   4. timeout exact codes
 *   5. connection exact codes OR 08 SQLSTATE class prefix
 *   6. timeout by name (AbortError, TimeoutError)
 *   7. unknown
 */
export function classifyAdminDataError(err: unknown): AdminDataFailureCause {
  if (err === null || err === undefined) return "unknown";
  if (typeof err !== "object") return "unknown";

  const codeRaw = safeReadKey(err, "code");
  const nameRaw = safeReadKey(err, "name");
  const code = codeRaw.toUpperCase();
  const name = nameRaw;

  // 1. schema exact
  if (code && SCHEMA_CODES.has(code)) return "schema";

  // 2. permission exact OR 0L*/0P* SQLSTATE class prefix
  if (code && PERMISSION_CODES.has(code)) return "permission";
  if (code.length >= 2 && (code.startsWith("0L") || code.startsWith("0P"))) {
    return "permission";
  }

  // 3. authentication exact
  if (code && AUTHENTICATION_CODES.has(code)) return "authentication";

  // 4. timeout exact
  if (code && TIMEOUT_CODES.has(code)) return "timeout";

  // 5. connection exact OR 08 SQLSTATE class prefix
  if (code && CONNECTION_CODES.has(code)) return "connection";
  if (code.length >= 2 && code.startsWith("08")) return "connection";

  // 6. timeout by name
  if (name && TIMEOUT_NAMES.has(name)) return "timeout";

  // 7. unknown
  return "unknown";
}

/**
 * Normalize an arbitrary string (e.g. from URL query params) into a valid
 * cause. Unknown or unexpected values collapse to "unknown".
 */
export function normalizeCause(value: string | null | undefined): AdminDataFailureCause {
  if (!value) return "unknown";
  return (ADMIN_DATA_FAILURE_CAUSES as readonly string[]).includes(value)
    ? (value as AdminDataFailureCause)
    : "unknown";
}
