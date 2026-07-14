import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// 浏览器端 Supabase 客户端单例（受 RLS 约束）
// 使用模块级缓存避免每次组件渲染都创建新实例，
// 否则 useEffect/useCallback 依赖 supabase 对象会反复触发请求
function makeBrowserClient(): SupabaseClient<Database> {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  ) as unknown as SupabaseClient<Database>;
}

type BrowserClient = ReturnType<typeof makeBrowserClient>;
let browserClient: BrowserClient | undefined;

export function createBrowserSupabaseClient(): BrowserClient {
  if (browserClient) return browserClient;

  browserClient = makeBrowserClient();

  return browserClient;
}
