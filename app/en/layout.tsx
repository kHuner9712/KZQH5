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
  const settings = localizeSiteSettings(siteSettings, "en");
  return {
    ...buildLocalizedMetadata({
      locale: "en",
      path: "/",
      title: settings.metaTitle || "KZQ | Engineering Panels",
      description:
        settings.metaDescription ||
        "KZQ engineering panel products and inquiry website.",
      image: siteSettings?.default_og_image_url,
    }),
    title: {
      default: settings.metaTitle || "KZQ | Engineering Panels",
      template: "%s | KZQ",
    },
  };
}

export default async function EnglishLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { company, siteSettings } = await getPublicSiteShellData();
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <ResponsiveShell
          company={company}
          siteSettings={siteSettings}
          locale="en"
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
