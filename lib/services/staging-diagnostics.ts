import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export type DiagnosticCheck = { ok: boolean; latencyMs: number };

export interface StagingDiagnosticsResult {
  success: boolean;
  checks: {
    products: DiagnosticCheck;
    searchRpc: DiagnosticCheck;
    certificates: DiagnosticCheck;
    projects: DiagnosticCheck;
    storage: DiagnosticCheck;
  };
  totalLatencyMs: number;
}

async function measure(
  check: () => Promise<boolean>,
): Promise<DiagnosticCheck> {
  const startedAt = performance.now();
  try {
    return {
      ok: await check(),
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  } catch {
    return {
      ok: false,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  }
}

async function fetchPublicStorageObject(
  url: string,
  signal: AbortSignal,
): Promise<boolean> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Range: "bytes=0-0" },
    signal,
  });
  return response.ok;
}

export async function runStagingDiagnostics(): Promise<StagingDiagnosticsResult> {
  const startedAt = performance.now();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    const unavailable = { ok: false, latencyMs: 0 };
    return {
      success: false,
      checks: {
        products: unavailable,
        searchRpc: unavailable,
        certificates: unavailable,
        projects: unavailable,
        storage: unavailable,
      },
      totalLatencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  }

  const client = createClient<Database>(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const [products, searchRpc, certificates, projects, storage] =
    await Promise.all([
      measure(async () => {
        const { error } = await client
          .from("products")
          .select("id")
          .eq("is_published", true)
          .limit(1);
        return !error;
      }),
      measure(async () => {
        const { error } = await client.rpc("search_published_products", {
          p_query: null,
          p_offset: 0,
          p_limit: 1,
        });
        return !error;
      }),
      measure(async () => {
        const { error } = await client
          .from("certificates")
          .select("id")
          .eq("is_published", true)
          .limit(1);
        return !error;
      }),
      measure(async () => {
        const { error } = await client
          .from("projects")
          .select("id")
          .eq("is_published", true)
          .limit(1);
        return !error;
      }),
      measure(async () => {
        const { data, error } = await client
          .from("product_assets")
          .select("file_url")
          .eq("is_published", true)
          .limit(1)
          .maybeSingle();
        if (error || !data?.file_url) return false;
        const publicUrl = new URL(data.file_url);
        const expectedOrigin = new URL(url).origin;
        if (
          publicUrl.origin !== expectedOrigin ||
          !publicUrl.pathname.startsWith(
            "/storage/v1/object/public/public-assets/",
          )
        ) {
          return false;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        try {
          return await fetchPublicStorageObject(
            publicUrl.toString(),
            controller.signal,
          );
        } finally {
          clearTimeout(timer);
        }
      }),
    ]);

  const checks = { products, searchRpc, certificates, projects, storage };
  return {
    success: Object.values(checks).every((check) => check.ok),
    checks,
    totalLatencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}
