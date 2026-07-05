import { ResponsiveShell } from "@/components/public/ResponsiveShell";
import { isDemoMode } from "@/lib/demo";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import { fetchSiteSettings } from "@/lib/queries/cms";
import { mockCompany } from "@/lib/mock-data";
import type { Metadata } from "next";
import type { CompanyProfile, SiteSettings } from "@/types/database";

// 公共布局只读取公开内容（company_profile / site_settings），
// 不依赖 cookies，允许 ISR 缓存。
export const revalidate = 300;

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
  let siteSettings: SiteSettings | null = null;

  if (isDemoMode()) {
    company = mockCompany;
    siteSettings = await fetchSiteSettings();
  } else {
    try {
      const supabase = createPublicSupabaseClient();
      const [{ data: companyData }, settings] = await Promise.all([
        supabase
          .from("company_profile")
          .select("*")
          .limit(1)
          .maybeSingle(),
        fetchSiteSettings(),
      ]);
      company = (companyData as CompanyProfile | null) || null;
      siteSettings = settings;
    } catch {
      company = null;
      siteSettings = null;
    }
  }

  return (
    <ResponsiveShell company={company} siteSettings={siteSettings}>
      {children}
    </ResponsiveShell>
  );
}

/**
 * 全局 SEO fallback
 * - 各页面自己的 generateMetadata 优先级最高（不覆盖其 title/description）
 * - 这里仅作为未被 generateMetadata 显式设置的页面的默认值
 * - 当 site_settings 配置了 global_meta_* 时，覆盖默认文案
 */
export async function generateMetadata(): Promise<Metadata> {
  const settings = await fetchSiteSettings();
  const title = settings?.global_meta_title_cn ?? "KZQ | 工程级板材·防火饰面板·海外出口供应商";
  const description =
    settings?.global_meta_description_cn ??
    "KZQ 专注工程级板材、B 级防火、E0 环保饰面板，服务国内工程精装与海外采购，支持定制规格与 FOB/CIF 出口。";
  return {
    title: {
      default: title,
      template: "%s | KZQ",
    },
    description,
    openGraph: {
      title,
      description,
      ...(settings?.default_og_image_url
        ? { images: [{ url: settings.default_og_image_url }] }
        : {}),
      type: "website",
      locale: "zh_CN",
    },
    robots: {
      index: true,
      follow: true,
    },
  };
}
