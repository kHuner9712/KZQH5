import { DesktopHeader } from "./DesktopHeader";
import { MobileNavController } from "./MobileNavController";
import { Footer } from "./Footer";
import type { CompanyProfile, SiteSettings } from "@/types/database";

/**
 * 响应式外壳
 * - mobile: 全宽 H5 风格，底部 Tab 导航（由 MobileNavController 按路径控制显隐）
 * - tablet/desktop: 顶部 sticky 导航，无底部 Tab
 * - PC 不再使用 430px 窄容器，而是全屏自适应
 * - Footer 出现在 main 之后、MobileNavController 之前
 */
export function ResponsiveShell({
  children,
  company,
  siteSettings,
}: {
  children: React.ReactNode;
  company?: CompanyProfile | null;
  siteSettings?: SiteSettings | null;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <DesktopHeader company={company} siteSettings={siteSettings} />
      <main className="flex-1 pb-24 md:pb-0">{children}</main>
      <Footer siteSettings={siteSettings} />
      <MobileNavController siteSettings={siteSettings} />
    </div>
  );
}
