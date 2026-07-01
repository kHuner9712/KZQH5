import { BottomNav } from "@/components/public/BottomNav";

/**
 * 前台 H5 公共布局
 * - 桌面浏览：容器居中，外侧浅灰背景
 * - 移动端：宽度 100%，最大 440px
 * - 严格禁止横向溢出
 */
export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-h5 flex-col overflow-x-hidden bg-canvas">
      <main className="flex-1 pb-24">{children}</main>
      <BottomNav />
    </div>
  );
}
