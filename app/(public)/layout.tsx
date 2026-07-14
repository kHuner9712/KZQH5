import type { Metadata, Viewport } from "next";
import { ResponsiveShell } from "@/components/public/ResponsiveShell";
import { localizeSiteSettings } from "@/lib/i18n/content";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";
import { getPublicSiteShellData } from "@/lib/services/public-site";

export const revalidate = 300;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0D0F10",
};

export async function generateMetadata(): Promise<Metadata> {
  const { siteSettings } = await getPublicSiteShellData();
  const settings = localizeSiteSettings(siteSettings, "zh");
  return {
    ...buildLocalizedMetadata({
      locale: "zh",
      path: "/",
      title: settings.metaTitle || "KZQ | 工程级板材",
      description: settings.metaDescription || "KZQ 工程级板材产品与询盘网站。",
      image: siteSettings?.default_og_image_url,
    }),
    title: { default: settings.metaTitle || "KZQ | 工程级板材", template: "%s | KZQ" },
  };
}

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const { company, siteSettings } = await getPublicSiteShellData();
  return <ResponsiveShell company={company} siteSettings={siteSettings} locale="zh" wechatEnabled={Boolean(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET)}>{children}</ResponsiveShell>;
}
