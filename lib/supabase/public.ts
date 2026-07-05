import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// ============================================================
// 公共前台只读 Supabase 客户端
// ------------------------------------------------------------
// 用途：仅供 (public) 路由组下的 Server Components / sitemap.ts
//      读取公开内容（products / categories / certificates /
//      company_profile / site_settings / homepage_content /
//      page_content 等公开表）。
//
// 与 lib/supabase/server.ts 的差异：
//   - 不读取 cookies()
//   - 不携带用户会话
//   - 不持久化 session，不自动刷新 token，不从 URL 检测 session
//   - 因此不会触发 Next.js 的 Dynamic server usage (cookies)
//   - 适合 ISR / CDN 缓存
//
// 安全：
//   - 仅使用 NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY
//   - 受 Supabase RLS 约束（公共读策略）
//   - 严禁使用 SUPABASE_SERVICE_ROLE_KEY
//   - 严禁用于后台 / Auth / 询盘写入等需要用户身份的场景
// ============================================================

let publicClient: SupabaseClient<Database> | null = null;

export function createPublicSupabaseClient() {
  if (publicClient) return publicClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("Missing public Supabase env vars");
  }

  publicClient = createClient<Database>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return publicClient;
}
