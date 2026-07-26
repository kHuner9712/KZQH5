import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "@/types/database";

// 服务端 Supabase 客户端（携带用户会话，受 RLS 约束）
// 用于 Server Components / Route Handlers / Server Actions
// Next.js 15: cookies() 变为异步，必须 await
export async function createServerSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: Record<string, unknown> }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options as Parameters<typeof cookieStore.set>[2])
            );
          } catch {
            // 在 Server Component 中调用 set 会抛错，可忽略
            // Route Handler / Server Action 中可正常 set
          }
        },
      },
    }
  );
}
