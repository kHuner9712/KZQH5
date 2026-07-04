import type { SiteSettings } from "@/types/database";

/**
 * 前台 Footer - 轻量单行
 * - PC 端完整展示
 * - 移动端简化展示，底部留出 pb 避开 BottomNav / 产品详情页 fixed CTA
 * - 内容优先使用 siteSettings.footer_text_cn，无配置时 fallback 到默认文案
 * - 出现在 main 之后、MobileNavController 之前
 */
export function Footer({
  siteSettings,
}: {
  siteSettings?: SiteSettings | null;
}) {
  const text =
    siteSettings?.footer_text_cn ||
    "© KZQ 工程级板材 · B级防火 · E0环保";

  return (
    <footer className="border-t border-ink-line bg-white pb-20 md:pb-0">
      <div className="mx-auto max-w-7xl px-4 py-3 text-center text-[11px] text-ink-mute md:py-6 md:text-xs">
        <p>{text}</p>
      </div>
    </footer>
  );
}
