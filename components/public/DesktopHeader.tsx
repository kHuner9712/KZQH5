"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { BrandLogo } from "./BrandLogo";
import type { CompanyProfile } from "@/types/database";

const navItems = [
  { href: "/products", label: "产品中心", en: "Products" },
  { href: "/certificates", label: "资质证书", en: "Certificates" },
  { href: "/about", label: "关于我们", en: "About" },
  { href: "/contact", label: "联系询盘", en: "Inquiry" },
];

/**
 * 桌面端顶部导航 Header
 * - 仅在 sm+ 显示（mobile 隐藏，由 MobileBottomNav 接管）
 * - sticky 顶部，简洁专业
 * - 含 Logo + 主导航 + 询盘 CTA
 */
export function DesktopHeader({
  company,
}: {
  company?: CompanyProfile | null;
}) {
  const pathname = usePathname();

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
            <p className="text-base font-bold tracking-tight text-ink">KZQ</p>
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
                {item.label}
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
