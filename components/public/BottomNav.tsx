"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, LayoutGrid, Award, Phone, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NavItem, SiteSettings } from "@/types/database";

// 默认移动端 tabs（fallback）
const defaultTabs: Array<{ href: string; label: string; icon: LucideIcon }> = [
  { href: "/", label: "首页", icon: Home },
  { href: "/products", label: "产品", icon: LayoutGrid },
  { href: "/certificates", label: "资质", icon: Award },
  { href: "/contact", label: "询盘", icon: Phone },
];

// 根据 href 映射图标
const iconMap: Record<string, LucideIcon> = {
  "/": Home,
  "/products": LayoutGrid,
  "/certificates": Award,
  "/contact": Phone,
};

/**
 * 移动端底部 Tab 导航 - 微信 H5 / 小程序风格
 * - 仅在 mobile（< md）显示
 * - tablet/desktop 由 DesktopHeader 接管
 * - 是否渲染由 MobileNavController 按路径决定（产品详情页隐藏）
 * - 固定优先展示 4 个入口：/ /products /certificates /contact
 * - 如果 site_settings.navigation_json 中存在这些 href，使用 CMS 中对应的 label_cn
 * - 如果 CMS 中缺少某项，则使用 defaultTabs fallback
 * - /about 不出现在移动端底部 Tab，保留在 PC 顶部导航
 * - 图标根据 href 映射：/ → Home，/products → LayoutGrid，/certificates → Award，/contact → Phone
 */
export function BottomNav({
  siteSettings,
}: {
  siteSettings?: SiteSettings | null;
}) {
  const pathname = usePathname();

  // 固定优先展示的 4 个入口
  const fixedHrefs = ["/", "/products", "/certificates", "/contact"];

  // 从 CMS navigation_json 中提取 label（按 href 匹配）
  const navMap = new Map<string, NavItem>();
  if (siteSettings?.navigation_json && siteSettings.navigation_json.length > 0) {
    for (const n of siteSettings.navigation_json) {
      if (n?.href) navMap.set(n.href, n);
    }
  }

  // 组装 tabs：固定 4 项，CMS 有 label 用 CMS，否则用 defaultTabs fallback
  const tabs: Array<{ href: string; label: string; icon: LucideIcon }> = fixedHrefs.map(
    (href) => {
      const cmsItem = navMap.get(href);
      const fallback = defaultTabs.find((t) => t.href === href);
      return {
        href,
        label: cmsItem?.label_cn || fallback?.label || "",
        icon: iconMap[href] || Home,
      };
    }
  );

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href);
  };

  return (
    <nav className="fixed bottom-0 left-0 z-50 w-full border-t border-ink-line bg-white/95 backdrop-blur-lg safe-bottom md:hidden">
      <div className="flex items-stretch justify-around px-2">
        {tabs.map((tab) => {
          const active = isActive(tab.href);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "relative flex flex-1 flex-col items-center justify-center gap-1 py-2.5 transition",
                active ? "text-industrial" : "text-ink-mute"
              )}
            >
              {active && (
                <span className="absolute top-0 h-0.5 w-7 rounded-full bg-industrial" />
              )}
              <Icon
                className={cn("h-5 w-5 transition-transform", active && "scale-110")}
                strokeWidth={active ? 2.4 : 2}
              />
              <span
                className={cn(
                  "text-[10px]",
                  active ? "font-semibold" : "font-medium"
                )}
              >
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
