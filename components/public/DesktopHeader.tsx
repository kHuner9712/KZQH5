"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { BrandLogo } from "./BrandLogo";
import type { CompanyProfile, NavItem, SiteSettings } from "@/types/database";

// 默认导航（fallback）
const defaultNavItems: NavItem[] = [
  { href: "/products", label_cn: "产品中心", label_en: "Products" },
  { href: "/certificates", label_cn: "资质证书", label_en: "Certificates" },
  { href: "/about", label_cn: "关于我们", label_en: "About" },
  { href: "/contact", label_cn: "联系询盘", label_en: "Inquiry" },
];

/**
 * 桌面端顶部导航 Header
 * - 仅在 sm+ 显示（mobile 隐藏，由 MobileBottomNav 接管）
 * - sticky 顶部，简洁专业
 * - 含 Logo + 主导航 + 询盘 CTA
 * - 优先使用 site_settings.navigation_json，无配置时 fallback 到默认导航
 * - Logo 旁品牌名优先使用 site_settings.brand_name / site_name_cn
 */
export function DesktopHeader({
  company,
  siteSettings,
}: {
  company?: CompanyProfile | null;
  siteSettings?: SiteSettings | null;
}) {
  const pathname = usePathname();

  // 导航：优先 site_settings.navigation_json（过滤首页项，桌面端首页由 Logo 承载）
  const navItems: NavItem[] =
    siteSettings?.navigation_json && siteSettings.navigation_json.length > 0
      ? siteSettings.navigation_json.filter((n) => n.href !== "/")
      : defaultNavItems;

  // 品牌名：优先 brand_name，其次 site_name_cn，最后默认 "KZQ"
  const brandName =
    siteSettings?.brand_name || siteSettings?.site_name_cn || "KZQ";

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href);
  };

  return (
    <header className="sticky top-0 z-40 hidden border-b border-ink-line/80 bg-white/90 backdrop-blur-lg md:block">
      <div className="container-responsive flex h-16 items-center justify-between">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2.5">
          <BrandLogo logoUrl={company?.logo_url} size={36} />
          <div className="leading-tight">
            <p className="text-base font-bold tracking-tight text-ink">{brandName}</p>
            <p className="text-[9px] uppercase tracking-[0.18em] text-ink-mute">
              Engineering Boards
            </p>
          </div>
        </Link>

        {/* 主导航 */}
        <nav className="flex items-center gap-1">
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "relative rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors",
                  active
                    ? "text-industrial"
                    : "text-ink-soft hover:text-ink"
                )}
              >
                {item.label_cn}
                {active && (
                  <span className="absolute bottom-0 left-1/2 h-0.5 w-6 -translate-x-1/2 rounded-full bg-industrial" />
                )}
              </Link>
            );
          })}
        </nav>

        {/* 询盘 CTA */}
        <Link
          href="/contact"
          className="btn-primary h-9 px-4 text-[12px]"
        >
          立即询盘
        </Link>
      </div>
    </header>
  );
}
