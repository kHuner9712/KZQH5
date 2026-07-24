import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { getVerifiedAdmin } from "@/lib/services/admin-auth";
import {
  isSameOrigin,
  isAllowedFetchSite,
  readJsonBody,
} from "@/lib/services/http-security";

/**
 * Fixed error codes for admin write endpoints. These are the ONLY strings
 * returned to the client and the ONLY codes written to server logs. No
 * database error text, SQLSTATE, table name, or Supabase error payload is
 * ever forwarded to the client.
 */
export type AdminWriteErrorCode =
  | "ADMIN_WRITE_UNAUTHORIZED"
  | "ADMIN_WRITE_FORBIDDEN_ORIGIN"
  | "ADMIN_WRITE_BAD_REQUEST"
  | "ADMIN_WRITE_PAYLOAD_TOO_LARGE"
  | "ADMIN_WRITE_UNSUPPORTED_MEDIA"
  | "ADMIN_WRITE_DEMO"
  | "ADMIN_WRITE_CONFLICT"
  | "ADMIN_WRITE_FAILED"
  | "ADMIN_WRITE_FORBIDDEN_ROLE";

/**
 * RBAC: admin role hierarchy for application-layer access control.
 *
 * service_role bypasses RLS entirely, so RBAC MUST be enforced at the
 * application layer — not via database policies. These roles are enforced
 * by the admin_profiles_role_check CHECK constraint (Phase 3 migration).
 *
 *   super_admin : full access, including admin user management
 *   admin       : standard CMS writes (products, projects, inquiries, etc.)
 *   editor      : limited writes (content edits only, no destructive ops)
 *
 * A role of NULL or any other value is treated as the most restrictive
 * (deny-by-default). The check is ALWAYS deny-by-default for unknown roles.
 */
export type AdminWriteRole = "super_admin" | "admin" | "editor";

const ROLE_RANK: Record<AdminWriteRole, number> = {
  editor: 1,
  admin: 2,
  super_admin: 3,
};

/**
 * Check if the verified admin's role meets the minimum required level.
 * Returns true if allowed, false if denied.
 *
 * Unknown / null roles are ALWAYS denied (deny-by-default).
 */
export function hasAdminRole(
  profile: { role?: string | null },
  minimum: AdminWriteRole,
): boolean {
  const role = profile.role;
  if (!role || !(role in ROLE_RANK)) return false;
  return ROLE_RANK[role as AdminWriteRole] >= ROLE_RANK[minimum];
}

/**
 * Build a 403 response for a role-denied write attempt.
 */
export function adminRoleDenied(minimum: AdminWriteRole): NextResponse {
  return adminWriteError("ADMIN_WRITE_FORBIDDEN_ROLE", 403, {
    logCode: `ADMIN_ROLE_DENIED_MIN_${minimum.toUpperCase()}`,
  });
}

export interface VerifiedAdmin {
  client: SupabaseClient<Database>;
  user: { id: string; email?: string };
  profile: { id: string; role?: string | null };
}

export type RequireAdminWriteResult<T> =
  | ({ ok: true } & VerifiedAdmin & { body: T })
  | { ok: false; response: NextResponse };

/**
 * Options for requireAdminWrite.
 */
export interface RequireAdminWriteOptions {
  /** Maximum request body size in bytes. */
  maxBytes: number;
  /**
   * Minimum admin role required to perform the write.
   *   - "admin"       : standard CMS writes (products, inquiries, etc.)
   *   - "super_admin" : admin user/role management
   *   - "editor"      : limited content edits (use sparingly — most write
   *                     endpoints require "admin")
   * Defaults to "admin" — deny-by-default for unknown/null roles.
   */
  minimumRole?: AdminWriteRole;
  /**
   * Body handling mode.
   *   - "json" (default): enforce application/json Content-Type and parse
   *     the JSON body (maxBytes applies to the body).
   *   - "skip": do NOT parse the body or enforce a Content-Type. Use for
   *     multipart/form-data uploads where the route reads the body itself.
   *     Origin + RBAC + a coarse whole-request Content-Length cap (maxBytes)
   *     still apply; the route owns Content-Type validation and per-field
   *     size limits.
   */
  body?: "json" | "skip";
}

/**
 * Centralized pre-flight check for every admin write endpoint:
 *   1. Verify the admin session + profile (service_role client).
 *   2. RBAC: enforce the minimum required admin role (deny-by-default).
 *   3. Phase 6: Combined CSRF defense (Origin + Sec-Fetch-Site).
 *      Origin MUST be present and match (fail-closed for missing Origin).
 *   4. Enforce application/json Content-Type.
 *   5. Enforce a maximum request body size.
 *   6. Parse the JSON body.
 *
 * On any failure returns a ready-to-send {@link NextResponse} carrying only a
 * fixed error code. On success returns the verified admin context plus the
 * parsed body for route-specific validation.
 *
 * Usage:
 *   const guard = await requireAdminWrite(request, {
 *     maxBytes: 256 * 1024,
 *     minimumRole: "admin",
 *   });
 */
export async function requireAdminWrite<T = unknown>(
  request: NextRequest,
  options: RequireAdminWriteOptions,
): Promise<RequireAdminWriteResult<T>>;

/**
 * Legacy overload: requireAdminWrite(request, maxBytes).
 * Assumes minimumRole = "admin". Prefer the options-object form.
 *
 * @deprecated Use the options-object form instead.
 */
export async function requireAdminWrite<T = unknown>(
  request: NextRequest,
  maxBytes: number,
): Promise<RequireAdminWriteResult<T>>;

export async function requireAdminWrite<T = unknown>(
  request: NextRequest,
  optionsOrMaxBytes: RequireAdminWriteOptions | number,
): Promise<RequireAdminWriteResult<T>> {
  const options: RequireAdminWriteOptions =
    typeof optionsOrMaxBytes === "number"
      ? { maxBytes: optionsOrMaxBytes }
      : optionsOrMaxBytes;

  const admin = await getVerifiedAdmin();
  if (!admin.ok) {
    return {
      ok: false,
      response: adminWriteError("ADMIN_WRITE_UNAUTHORIZED", 401),
    };
  }

  // RBAC: enforce the minimum required role BEFORE anything else.
  // Unknown / null roles are ALWAYS denied (deny-by-default).
  const minimumRole: AdminWriteRole = options.minimumRole ?? "admin";
  if (!hasAdminRole(admin.profile, minimumRole)) {
    return {
      ok: false,
      response: adminRoleDenied(minimumRole),
    };
  }

  // Phase 6: Combined Origin + Sec-Fetch-Site check for admin writes.
  // Admin write endpoints use a STRICTER policy than general endpoints:
  //   - Origin MUST be present and match (fail-closed for missing Origin)
  //   - Sec-Fetch-Site, if present, must be same-origin/none (defense-in-depth)
  // This preserves the deny-by-default model: a missing Origin on a
  // state-changing admin request is always rejected, never treated as a
  // trusted non-browser client. Non-browser callers (release scripts) must
  // send an explicit same-origin Origin header.
  if (!isSameOrigin(request) || !isAllowedFetchSite(request)) {
    return {
      ok: false,
      response: adminWriteError("ADMIN_WRITE_FORBIDDEN_ORIGIN", 403),
    };
  }

  if (options.body === "skip") {
    // Multipart/binary uploads (e.g. Storage file uploads): enforce a coarse
    // whole-request size cap but leave Content-Type validation and body
    // parsing to the route. The route still benefits from session + RBAC +
    // same-origin checks and must apply per-field size limits itself.
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
      return {
        ok: false,
        response: adminWriteError("ADMIN_WRITE_PAYLOAD_TOO_LARGE", 413),
      };
    }
    return {
      ok: true,
      client: admin.client,
      user: admin.user,
      profile: admin.profile,
      body: undefined as unknown as T,
    };
  }

  const parsed = await readJsonBody<T>(request, options.maxBytes);
  if (!parsed.ok) {
    const code =
      parsed.status === 413
        ? "ADMIN_WRITE_PAYLOAD_TOO_LARGE"
        : parsed.status === 415
          ? "ADMIN_WRITE_UNSUPPORTED_MEDIA"
          : "ADMIN_WRITE_BAD_REQUEST";
    return { ok: false, response: adminWriteError(code, parsed.status) };
  }

  return {
    ok: true,
    client: admin.client,
    user: admin.user,
    profile: admin.profile,
    body: parsed.value,
  };
}

/**
 * Build a JSON error response carrying only a fixed error code. Optionally
 * log a coarse server-side code (never the underlying error payload).
 */
export function adminWriteError(
  code: AdminWriteErrorCode,
  status: number,
  options?: { logCode?: string; cause?: unknown },
): NextResponse {
  if (options?.logCode) {
    // Log ONLY the fixed code. Never log the cause object, message, stack,
    // or any database/Supabase error payload.
    console.warn(options.logCode);
  } else {
    // Touch cause so linters don't complain; we intentionally drop it.
    void options?.cause;
  }
  return NextResponse.json({ error: code }, { status });
}

/**
 * Wrap a write operation, classifying any thrown error into a fixed
 * `ADMIN_WRITE_FAILED` 500 (or `ADMIN_WRITE_CONFLICT` 409 for optimistic-lock
 * / unique-violation). The original error is never forwarded.
 */
export async function runAdminWrite<T>(
  operation: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: NextResponse }> {
  try {
    const value = await operation();
    return { ok: true, value };
  } catch (err) {
    const code = pickFailureCode(err);
    const status = code === "ADMIN_WRITE_CONFLICT" ? 409 : 500;
    return {
      ok: false,
      response: adminWriteError(code, status, {
        logCode: code,
        cause: err,
      }),
    };
  }
}

function pickFailureCode(err: unknown): AdminWriteErrorCode {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      const upper = code.toUpperCase();
      // 23505 unique_violation, 40P01 serialization_failure, 40001
      // serialization_failure -> optimistic lock / duplicate -> conflict.
      if (upper === "23505" || upper === "40P01" || upper === "40001") {
        return "ADMIN_WRITE_CONFLICT";
      }
      // PGRST116 = "JSON could not be parsed" or schema mismatch on update;
      // treat as bad request rather than 500 to avoid masking client errors.
      if (upper === "PGRST116") return "ADMIN_WRITE_BAD_REQUEST";
    }
  }
  return "ADMIN_WRITE_FAILED";
}
