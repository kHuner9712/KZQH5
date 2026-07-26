import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// 服务端特权客户端（使用 service_role key，绕过 RLS）
// 严禁暴露到客户端组件，严禁加 NEXT_PUBLIC_ 前缀
// 仅用于：询盘写入（匿名场景）、服务端强写入场景
export function createAdminSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 环境变量"
    );
  }

  return createClient<Database>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * 服务端特权客户端的统一别名。新代码（如可信 Storage 上传边界）优先使用
 * createAdminClient；createAdminSupabaseClient 保留以兼容已有调用与测试 mock。
 * 两者指向同一个 service_role 客户端工厂。
 */
export const createAdminClient = createAdminSupabaseClient;
