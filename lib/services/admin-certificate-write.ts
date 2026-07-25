/**
 * Certificate admin write service (Section 6).
 *
 * Trusted server-side boundary for all certificates CRUD operations.
 * The admin UI MUST call the /api/admin/certificates/* routes which
 * in turn call these functions — never the Browser Supabase client.
 *
 * Every write goes through a transactional RPC that:
 *   - enforces optimistic lock (expected_updated_at required)
 *   - writes audit in the same transaction (no best-effort audit)
 *   - enqueues replaced/old storage objects for cleanup atomically
 *
 * Errors are classified into coarse-grained AdminWriteErrorCode values;
 * SQL / internal details are never forwarded to the client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Certificate, Database } from "@/types/database";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import type {
  ProductAssetAccessLevel,
  ProductAssetSourceType,
} from "@/types/database";

export type CertificateWriteResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: AdminWriteErrorCode };

export interface AdminActor {
  id: string;
  email?: string | null;
  role?: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function classifyPgError(errCode: string | undefined): AdminWriteErrorCode {
  if (!errCode) return "ADMIN_WRITE_FAILED";
  if (errCode === "22004" || errCode === "P0002") return "ADMIN_WRITE_BAD_REQUEST";
  if (errCode === "40P01" || errCode === "40001" || errCode === "23505") {
    return "ADMIN_WRITE_CONFLICT";
  }
  return "ADMIN_WRITE_FAILED";
}

function extractErrCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: string }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * List all certificates for the admin UI. Uses service_role; the admin UI
 * must NOT read certificates directly via the Browser Supabase client.
 */
export async function listAllCertificates(
  client: SupabaseClient<Database>,
): Promise<CertificateWriteResult<Certificate[]>> {
  try {
    const { data, error } = await client
      .from("certificates")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });
    if (error) {
      console.error("CERTIFICATE_LIST_FAILED", { code: "ADMIN_WRITE_FAILED" });
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: (data as Certificate[] | null) || [] };
  } catch {
    console.error("CERTIFICATE_LIST_EXCEPTION", { code: "ADMIN_WRITE_FAILED" });
    return { ok: false, code: "ADMIN_WRITE_FAILED" };
  }
}

/**
 * Create or update a certificate draft via save_certificate_draft RPC.
 *
 * Draft model (Section 6, parallel to Catalog Section 4):
 *   - source_bucket must be 'private-assets'
 *   - source_object_path is the server-generated private path
 *   - image_url is NOT saved in draft (null or previous published URL)
 *   - publish_status = 'draft'
 *
 * On UPDATE, expectedUpdatedAt is REQUIRED (optimistic lock).
 * On INSERT (id=null), expectedUpdatedAt is ignored.
 */
export async function saveCertificateDraft(
  client: SupabaseClient<Database>,
  input: {
    id?: string | null;
    payload: CertificatePayload;
    sourceBucket: string;
    sourceObjectPath: string;
    mimeType?: string | null;
    fileSize?: number | null;
    sha256?: string | null;
    expectedUpdatedAt?: string | null;
    accessLevel?: ProductAssetAccessLevel;
    sourceType?: ProductAssetSourceType | null;
  },
  actor: AdminActor,
): Promise<CertificateWriteResult<{ id: string; updatedAt: string }>> {
  // Validate payload
  if (!input.payload.name_cn || input.payload.name_cn.trim().length === 0) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  // Draft source must be private-assets
  if (input.sourceBucket !== "private-assets") {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (!input.sourceObjectPath || input.sourceObjectPath.trim().length === 0) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  // On update: id must be valid UUID and expectedUpdatedAt required
  if (input.id) {
    if (!UUID_RE.test(input.id)) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
    if (!input.expectedUpdatedAt) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
  }

  // Build the JSON payload for the RPC (whitelisted fields only)
  const rpcPayload = {
    name_cn: input.payload.name_cn,
    name_en: input.payload.name_en || null,
    description_cn: input.payload.description_cn || null,
    description_en: input.payload.description_en || null,
    applicable_scope_cn: input.payload.applicable_scope_cn || null,
    applicable_scope_en: input.payload.applicable_scope_en || null,
    sort_order: input.payload.sort_order,
    is_published: false, // Draft is never published
    access_level: input.accessLevel ?? "private",
    source_type: input.sourceType ?? null,
    authorization_status: "pending",
  };

  try {
    const { data, error } = await client.rpc("save_certificate_draft", {
      p_id: input.id ?? null,
      p_payload: rpcPayload,
      p_source_bucket: input.sourceBucket,
      p_source_object_path: input.sourceObjectPath,
      p_mime_type: input.mimeType ?? null,
      p_file_size: input.fileSize ?? null,
      p_sha256: input.sha256 ?? null,
      p_expected_updated_at: input.expectedUpdatedAt ?? null,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("CERTIFICATE_DRAFT_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    const result = data as { id?: string; updated_at?: string; status?: string } | null;
    if (!result || !result.id || !result.updated_at) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: result.id, updatedAt: result.updated_at } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("CERTIFICATE_DRAFT_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

/**
 * Update certificate metadata (non-storage fields) via
 * update_certificate_metadata RPC. Does NOT change the source ref
 * or publish state. Optimistic lock required.
 */
export async function updateCertificateMetadata(
  client: SupabaseClient<Database>,
  input: {
    id: string;
    payload: Partial<CertificatePayload>;
    expectedUpdatedAt: string;
    accessLevel?: ProductAssetAccessLevel;
    sourceType?: ProductAssetSourceType | null;
  },
  actor: AdminActor,
): Promise<CertificateWriteResult<{ id: string; updatedAt: string }>> {
  if (!UUID_RE.test(input.id)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (!input.expectedUpdatedAt) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  const rpcPayload = {
    name_cn: input.payload.name_cn,
    name_en: input.payload.name_en ?? null,
    description_cn: input.payload.description_cn ?? null,
    description_en: input.payload.description_en ?? null,
    applicable_scope_cn: input.payload.applicable_scope_cn ?? null,
    applicable_scope_en: input.payload.applicable_scope_en ?? null,
    sort_order: input.payload.sort_order ?? 0,
    is_published: input.payload.is_published ?? false,
    access_level: input.accessLevel ?? "private",
    source_type: input.sourceType ?? null,
  };

  try {
    const { data, error } = await client.rpc("update_certificate_metadata", {
      p_id: input.id,
      p_payload: rpcPayload,
      p_expected_updated_at: input.expectedUpdatedAt,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("CERTIFICATE_UPDATE_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    const result = data as { id?: string; updated_at?: string; status?: string } | null;
    if (!result || !result.id || !result.updated_at) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: result.id, updatedAt: result.updated_at } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("CERTIFICATE_UPDATE_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

/**
 * Delete a certificate atomically via delete_certificate_with_cleanup RPC.
 * The RPC enqueues both published and source objects for cleanup in the
 * same transaction. Optimistic lock required.
 */
export async function deleteCertificate(
  client: SupabaseClient<Database>,
  input: { id: string; expectedUpdatedAt: string },
  actor: AdminActor,
): Promise<CertificateWriteResult<{ id: string }>> {
  if (!UUID_RE.test(input.id)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (!input.expectedUpdatedAt) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  try {
    const { data, error } = await client.rpc("delete_certificate_with_cleanup", {
      p_id: input.id,
      p_expected_updated_at: input.expectedUpdatedAt,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("CERTIFICATE_DELETE_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    const result = data as { id?: string; status?: string } | null;
    if (!result || !result.id) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: result.id } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("CERTIFICATE_DELETE_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

/**
 * Authorize a certificate via authorize_certificate RPC.
 * This is a DEDICATED server-side command — not a generic PATCH.
 * Sets authorization_status='confirmed' with atomic audit.
 * Optimistic lock required.
 */
export async function authorizeCertificate(
  client: SupabaseClient<Database>,
  input: { id: string; expectedUpdatedAt: string },
  actor: AdminActor,
): Promise<CertificateWriteResult<{ id: string; updatedAt: string }>> {
  if (!UUID_RE.test(input.id)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (!input.expectedUpdatedAt) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  try {
    const { data, error } = await client.rpc("authorize_certificate", {
      p_id: input.id,
      p_expected_updated_at: input.expectedUpdatedAt,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("CERTIFICATE_AUTHORIZE_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    // RPC returns timestamptz (the new updated_at) directly
    const updatedAt = typeof data === "string" ? data : "";
    if (!updatedAt) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: input.id, updatedAt } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("CERTIFICATE_AUTHORIZE_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

/**
 * Unpublish a certificate via unpublish_certificate RPC.
 * Sets is_published=false, publish_status='draft', clears published ref.
 * Enqueues old public object for cleanup atomically.
 * Optimistic lock required.
 */
export async function unpublishCertificate(
  client: SupabaseClient<Database>,
  input: { id: string; expectedUpdatedAt: string },
  actor: AdminActor,
): Promise<CertificateWriteResult<{ id: string; updatedAt: string }>> {
  if (!UUID_RE.test(input.id)) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }
  if (!input.expectedUpdatedAt) {
    return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
  }

  try {
    const { data, error } = await client.rpc("unpublish_certificate", {
      p_id: input.id,
      p_expected_updated_at: input.expectedUpdatedAt,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const errCode = extractErrCode(error);
      console.error("CERTIFICATE_UNPUBLISH_FAILED", { code: classifyPgError(errCode) });
      return { ok: false, code: classifyPgError(errCode) };
    }

    const result = data as { id?: string; updated_at?: string; status?: string } | null;
    if (!result || !result.id || !result.updated_at) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return { ok: true, data: { id: result.id, updatedAt: result.updated_at } };
  } catch (err) {
    const errCode = extractErrCode(err);
    console.error("CERTIFICATE_UNPUBLISH_EXCEPTION", { code: classifyPgError(errCode) });
    return { ok: false, code: classifyPgError(errCode) };
  }
}

/**
 * Certificate payload (whitelisted, non-storage fields).
 */
export interface CertificatePayload {
  name_cn: string;
  name_en: string | null;
  description_cn: string | null;
  description_en: string | null;
  applicable_scope_cn: string | null;
  applicable_scope_en: string | null;
  sort_order: number;
  is_published: boolean;
}
