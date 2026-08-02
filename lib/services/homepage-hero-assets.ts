import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { HomeHeroSlide } from "@/types/homepage";
import {
  deletePublicAsset,
  enqueueStorageCleanup,
  isReferencedStorageObject,
} from "@/lib/services/storage-upload";

const PUBLIC_OBJECT_PREFIX = "/storage/v1/object/public/public-assets/";
const MANAGED_HERO_PATH_RE = /^site\/[a-zA-Z0-9._/-]+\.(?:webp|png|jpe?g)$/i;

type CleanupClaim = {
  id: string;
  bucket: "public-assets";
  object_path: string;
  lock_token: string;
};

type RpcError = { code?: string; message?: string } | null;
type CleanupRpcClient = {
  rpc(
    name: "claim_storage_cleanup_object",
    args: {
      p_bucket: string;
      p_object_path: string;
      p_stale_timeout_seconds?: number;
    },
  ): Promise<{ data: unknown; error: RpcError }>;
  rpc(
    name: "complete_storage_cleanup",
    args: {
      p_cleanup_id: string;
      p_lock_token: string;
      p_success: boolean;
      p_error_code?: string | null;
      p_storage_operation_id?: string | null;
      p_final_status?: string | null;
    },
  ): Promise<{ data: unknown; error: RpcError }>;
};

function extractManagedHeroPath(url: string | null | undefined): string | null {
  if (!url || url.startsWith("/")) return null;
  const configuredBase = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!configuredBase) return null;

  try {
    const parsed = new URL(url);
    const base = new URL(configuredBase);
    if (parsed.origin !== base.origin) return null;
    if (!parsed.pathname.startsWith(PUBLIC_OBJECT_PREFIX)) return null;
    const path = decodeURIComponent(parsed.pathname.slice(PUBLIC_OBJECT_PREFIX.length));
    if (!MANAGED_HERO_PATH_RE.test(path) || path.includes("..")) return null;
    return path;
  } catch {
    return null;
  }
}

export function collectManagedHeroPaths(slides: readonly HomeHeroSlide[]): Set<string> {
  const paths = new Set<string>();
  for (const slide of slides) {
    const desktop = extractManagedHeroPath(slide.desktop_image_url);
    const mobile = extractManagedHeroPath(slide.mobile_image_url);
    if (desktop) paths.add(desktop);
    if (mobile) paths.add(mobile);
  }
  return paths;
}

function asCleanupClaim(value: unknown): CleanupClaim | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    row.bucket !== "public-assets" ||
    typeof row.object_path !== "string" ||
    typeof row.lock_token !== "string"
  ) {
    return null;
  }
  return {
    id: row.id,
    bucket: "public-assets",
    object_path: row.object_path,
    lock_token: row.lock_token,
  };
}

async function claimCleanup(
  client: SupabaseClient<Database>,
  objectPath: string,
): Promise<CleanupClaim | null> {
  const rpcClient = client as unknown as CleanupRpcClient;
  const { data, error } = await rpcClient.rpc("claim_storage_cleanup_object", {
    p_bucket: "public-assets",
    p_object_path: objectPath,
    p_stale_timeout_seconds: 300,
  });
  if (error) {
    console.error("HERO_CLEANUP_CLAIM_FAILED", { objectPath, code: error.code });
    return null;
  }
  return asCleanupClaim(data);
}

async function completeCleanup(
  client: SupabaseClient<Database>,
  claim: CleanupClaim,
  input: {
    success: boolean;
    errorCode?: string | null;
    finalStatus: string;
  },
): Promise<boolean> {
  const rpcClient = client as unknown as CleanupRpcClient;
  const { data, error } = await rpcClient.rpc("complete_storage_cleanup", {
    p_cleanup_id: claim.id,
    p_lock_token: claim.lock_token,
    p_success: input.success,
    p_error_code: input.errorCode ?? null,
    p_storage_operation_id: null,
    p_final_status: input.finalStatus,
  });
  if (error || typeof data !== "string") {
    console.error("HERO_CLEANUP_COMPLETE_FAILED", {
      objectPath: claim.object_path,
      code: error?.code,
    });
    return false;
  }
  return data === "completed" || data === "retry" || data === "dead_letter";
}

export async function processRemovedHomepageHeroAssets(input: {
  client: SupabaseClient<Database>;
  previousSlides: readonly HomeHeroSlide[];
  nextSlides: readonly HomeHeroSlide[];
  sourceId: string;
  actor: { id: string; role?: string | null };
}): Promise<{ attempted: number; deleted: number; deferred: number }> {
  const previous = collectManagedHeroPaths(input.previousSlides);
  const next = collectManagedHeroPaths(input.nextSlides);
  const removed = [...previous].filter((path) => !next.has(path));
  let deleted = 0;
  let deferred = 0;

  for (const objectPath of removed) {
    let claim = await claimCleanup(input.client, objectPath);
    if (!claim) {
      await enqueueStorageCleanup({
        bucket: "public-assets",
        objectPath,
        reason: "replaced",
        sourceType: "homepage_hero",
        sourceId: input.sourceId,
      });
      claim = await claimCleanup(input.client, objectPath);
    }
    if (!claim) {
      deferred += 1;
      continue;
    }

    const referenced = await isReferencedStorageObject("public-assets", objectPath);
    if (!referenced.ok) {
      deferred += 1;
      await completeCleanup(input.client, claim, {
        success: false,
        errorCode: "REFERENCE_CHECK_FAILED",
        finalStatus: "reference_check_failed",
      });
      continue;
    }
    if (referenced.referenced) {
      deferred += 1;
      await completeCleanup(input.client, claim, {
        success: true,
        finalStatus: "blocked_referenced",
      });
      continue;
    }

    const result = await deletePublicAsset(objectPath, {
      actorId: input.actor.id,
      actorRole: input.actor.role ?? null,
    });
    if (!result.ok) {
      deferred += 1;
      await completeCleanup(input.client, claim, {
        success: false,
        errorCode: "STORAGE_DELETE_FAILED",
        finalStatus: "storage_delete_failed",
      });
      continue;
    }

    deleted += 1;
    await completeCleanup(input.client, claim, {
      success: true,
      finalStatus: "deleted",
    });
  }

  return { attempted: removed.length, deleted, deferred };
}
