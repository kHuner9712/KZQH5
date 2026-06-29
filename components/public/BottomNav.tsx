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

export function BottomNav() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href);
  };

  return (
    <nav className="fixed bottom-0 left-1/2 z-50 w-full max-w-h5 -translate-x-1/2 border-t border-gray-200 bg-white/95 backdrop-blur-lg safe-bottom">
      <div className="flex items-stretch justify-around">
        {tabs.map((tab) => {
          const active = isActive(tab.href);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-1 py-2.5 transition",
                active ? "text-steel" : "text-gray-400"
              )}
            >
              <Icon className={cn("h-5 w-5", active && "scale-110")} strokeWidth={active ? 2.4 : 2} />
              <span className={cn("text-[11px]", active ? "font-semibold" : "font-medium")}>
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
