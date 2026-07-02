import { DesktopHeader } from "./DesktopHeader";
import { MobileNavController } from "./MobileNavController";
import type { CompanyProfile } from "@/types/database";

/**
 * 响应式外壳
 * - mobile: 全宽 H5 风格，底部 Tab 导航（由 MobileNavController 按路径控制显隐）
 * - tablet/desktop: 顶部 sticky 导航，无底部 Tab
 * - PC 不再使用 430px 窄容器，而是全屏自适应
 */
export function ResponsiveShell({
  children,
  company,
}: {
  children: React.ReactNode;
  company?: CompanyProfile | null;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <DesktopHeader company={company} />
      <main className="flex-1 pb-24 md:pb-0">{children}</main>
      <MobileNavController />
    </div>
  );
}
