/**
 * Phase 3: Admin audit log service.
 *
 * Writes a tamper-evident record of every admin write operation to the
 * admin_audit_log table. The table has RLS enabled with NO policies, so
 * only the service_role client can insert/query — anon and authenticated
 * users cannot read or modify audit entries.
 *
 * Contract:
 *   * logAdminAction() is BEST-EFFORT: it never throws and never returns
 *     an error to the caller. A failed audit insert is logged to stderr
 *     with a fixed code (ADMIN_AUDIT_LOG_FAILED) and the write operation
 *     proceeds normally. The audit log is a forensic record, not a gate.
 *   * The `summary` field must NOT contain sensitive data (passwords,
 *     tokens, full inquiry messages, customer PII beyond what is already
 *     in the inquiry record). Keep it to action + target identification.
 *   * actor_id / actor_email / actor_role come from the verified admin
 *     session, NOT from the request body, so they cannot be forged.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export interface AuditActor {
  id: string;
  email?: string;
  role?: string | null;
}

export interface AuditLogParams {
  action: string;
  targetType: string;
  targetId?: string | null;
  summary?: string | null;
}

/**
 * Insert an audit log entry. Best-effort: swallows all errors.
 *
 * Usage:
 *   await logAdminAction(client, admin, {
 *     action: "product.create",
 *     targetType: "product",
 *     targetId: result.id,
 *     summary: `Created product "${name}"`,
 *   });
 */
export async function logAdminAction(
  client: SupabaseClient<Database>,
  actor: AuditActor,
  params: AuditLogParams,
): Promise<void> {
  try {
    const { error } = await client.from("admin_audit_log").insert({
      actor_id: actor.id,
      actor_email: actor.email ?? null,
      actor_role: actor.role ?? null,
      action: params.action,
      target_type: params.targetType,
      target_id: params.targetId ?? null,
      summary: params.summary ?? null,
    });
    if (error) {
      // Log only the fixed code — never the Supabase error payload.
      console.warn("ADMIN_AUDIT_LOG_FAILED");
    }
  } catch {
    // Network error, client-side throw, etc. Swallow and continue.
    console.warn("ADMIN_AUDIT_LOG_FAILED");
  }
}
