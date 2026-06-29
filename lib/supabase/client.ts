import { createBrowserClient } from "@supabase/ssr";

// 浏览器端 Supabase 客户端（使用 anon key，受 RLS 约束）
// 用于 Client Components
export function createBrowserSupabaseClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
