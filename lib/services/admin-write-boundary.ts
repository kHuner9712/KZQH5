import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { getVerifiedAdmin } from "@/lib/services/admin-auth";
import {
  isSameOrigin,
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
  | "ADMIN_WRITE_FAILED";

export interface VerifiedAdmin {
  client: SupabaseClient<Database>;
  user: { id: string; email?: string };
  profile: { id: string; role?: string | null };
}

export type RequireAdminWriteResult<T> =
  | ({ ok: true } & VerifiedAdmin & { body: T })
  | { ok: false; response: NextResponse };

/**
 * Centralized pre-flight check for every admin write endpoint:
 *   1. Verify the admin session + profile (service_role client).
 *   2. Fail-closed same-origin check (Origin missing -> rejected).
 *   3. Enforce application/json Content-Type.
 *   4. Enforce a maximum request body size.
 *   5. Parse the JSON body.
 *
 * On any failure returns a ready-to-send {@link NextResponse} carrying only a
 * fixed error code. On success returns the verified admin context plus the
 * parsed body for route-specific validation.
 */
export async function requireAdminWrite<T = unknown>(
  request: NextRequest,
  maxBytes: number,
): Promise<RequireAdminWriteResult<T>> {
  const admin = await getVerifiedAdmin();
  if (!admin.ok) {
    return {
      ok: false,
      response: adminWriteError("ADMIN_WRITE_UNAUTHORIZED", 401),
    };
  }

  if (!isSameOrigin(request)) {
    return {
      ok: false,
      response: adminWriteError("ADMIN_WRITE_FORBIDDEN_ORIGIN", 403),
    };
  }

  const parsed = await readJsonBody<T>(request, maxBytes);
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
