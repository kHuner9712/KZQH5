import type { Metadata, Viewport } from "next";
import { ResponsiveShell } from "@/components/public/ResponsiveShell";
import { localizeSiteSettings } from "@/lib/i18n/content";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";
import { getPublicSiteShellData } from "@/lib/services/public-site";
import "../globals.css";

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
      title: settings.metaTitle || "KZQ | 装饰墙板与木饰面",
      description:
        settings.metaDescription ||
        "KZQ 提供竹炭木饰面、竹木纤维护墙板、WPC/PVC/SPC 墙板、吸音板及配套装饰材料。",
      image: siteSettings?.default_og_image_url,
    }),
    title: {
      default: settings.metaTitle || "KZQ | 装饰墙板与木饰面",
      template: "%s | KZQ",
    },
  };
}

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { company, siteSettings } = await getPublicSiteShellData();
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">
        <ResponsiveShell
          company={company}
          siteSettings={siteSettings}
          locale="zh"
          wechatEnabled={Boolean(
            process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET,
          )}
        >
          {children}
        </ResponsiveShell>
      </body>
    </html>
  );
}
