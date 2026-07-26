"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Boxes,
  Folder,
  Grid2X2,
  Home,
  Phone,
  type LucideIcon,
} from "lucide-react";
import { localePath, pathWithoutLocale, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { cn } from "@/lib/utils";
import { InquiryCountBadge } from "./inquiry-list/InquiryCountBadge";

interface BottomTab {
  href: string;
  label: string;
  icon: LucideIcon;
  key: "home" | "categories" | "products" | "projects" | "contact";
}

export function BottomNav({ locale }: { locale: Locale }) {
  const pathname = pathWithoutLocale(usePathname());
  const copy = getDictionary(locale);
  const tabs: BottomTab[] = [
    { href: localePath(locale), label: copy.nav.home, icon: Home, key: "home" },
    {
      href: `${localePath(locale)}#categories`,
      label: locale === "zh" ? "分类" : "Categories",
      icon: Grid2X2,
      key: "categories",
    },
    {
      href: localePath(locale, "/products"),
      label: copy.nav.products,
      icon: Boxes,
      key: "products",
    },
    {
      href: localePath(locale, "/projects"),
      label: locale === "zh" ? "案例" : "Projects",
      icon: Folder,
      key: "projects",
    },
    {
      href: localePath(locale, "/contact"),
      label: copy.nav.inquiry,
      icon: Phone,
      key: "contact",
    },
  ];
  const isActive = (tab: BottomTab) => {
    if (tab.key === "home") return pathname === "/";
    if (tab.key === "categories") return false;
    const path = tab.href.replace(/^\/en/, "").split("#")[0] || "/";
    return pathname === path || pathname.startsWith(`${path}/`);
  };

  return (
    <nav
      className="safe-bottom fixed inset-x-0 bottom-0 z-50 h-[calc(56px+env(safe-area-inset-bottom))] border-t border-white/[0.08] bg-page/[0.95] backdrop-blur-xl md:hidden"
      aria-label={copy.header.mobileNavigation}
    >
      <div className="flex h-14 items-stretch">
        {tabs.map((tab) => {
          const active = isActive(tab);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.key}
              href={tab.href}
              className={cn(
                "relative flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 transition-colors",
                active ? "text-gold" : "text-ink-mute",
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-5 w-5" strokeWidth={active ? 2.2 : 1.8} />
              {tab.key === "contact" && (
                <InquiryCountBadge className="absolute left-[calc(50%+8px)] top-1 bg-gold text-page" />
              )}
              <span className="max-w-full truncate text-[10px] font-medium leading-none">
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
