"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, LayoutGrid, Award, Phone } from "lucide-react";
import { cn } from "@/lib/utils";

const tabs = [
  { href: "/", label: "首页", icon: Home },
  { href: "/products", label: "产品", icon: LayoutGrid },
  { href: "/certificates", label: "资质", icon: Award },
  { href: "/contact", label: "询盘", icon: Phone },
];

/**
 * 移动端底部 Tab 导航 - 微信 H5 / 小程序风格
 * - 仅在 mobile（< md）显示
 * - tablet/desktop 由 DesktopHeader 接管
 */
export function BottomNav() {
  const pathname = usePathname();

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
