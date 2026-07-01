import { ResponsiveShell } from "@/components/public/ResponsiveShell";
import { isDemoMode } from "@/lib/demo";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { mockCompany } from "@/lib/mock-data";
import type { CompanyProfile } from "@/types/database";

/**
 * 前台公共布局 - 响应式
 * - mobile: 全宽 H5 + 底部 Tab
 * - tablet/desktop: 顶部导航 + 全宽内容
 * - 不再使用 430px 窄容器
 */
export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let company: CompanyProfile | null = null;

  if (isDemoMode()) {
    company = mockCompany;
  } else {
    try {
      const supabase = createServerSupabaseClient();
      const { data } = await supabase
        .from("company_profile")
        .select("*")
        .limit(1)
        .maybeSingle();
      company = (data as CompanyProfile | null) || null;
    } catch {
      company = null;
    }
  }

  return <ResponsiveShell company={company}>{children}</ResponsiveShell>;
}
