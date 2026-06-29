import { createBrowserClient } from "@supabase/ssr";

// 浏览器端 Supabase 客户端单例（受 RLS 约束）
// 使用模块级缓存避免每次组件渲染都创建新实例，
// 否则 useEffect/useCallback 依赖 supabase 对象会反复触发请求
let browserClient: ReturnType<typeof createBrowserClient> | null = null;

export function createBrowserSupabaseClient() {
  if (browserClient) return browserClient;

  browserClient = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  return browserClient;
}
