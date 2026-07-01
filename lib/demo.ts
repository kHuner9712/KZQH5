// ============================================================
// Demo / Mock Preview 模式判断
// 当 NEXT_PUBLIC_DEMO_MODE=true 时，前台页面不请求 Supabase，直接使用 mock 数据。
// ============================================================

export function isDemoMode(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === "true";
}
