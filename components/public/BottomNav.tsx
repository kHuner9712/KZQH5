"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, LayoutGrid, Menu, MessageCircle, type LucideIcon } from "lucide-react";
import { localePath, pathWithoutLocale, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { cn } from "@/lib/utils";
import { InquiryCountBadge } from "./inquiry-list/InquiryCountBadge";

export function BottomNav({ locale }: { locale: Locale }) {
  const pathname = pathWithoutLocale(usePathname());
  const copy = getDictionary(locale);
  const tabs: Array<{ href: string; label: string; icon: LucideIcon }> = [
    { href: "/", label: copy.nav.home, icon: Home },
    { href: "/products", label: copy.nav.products, icon: LayoutGrid },
    { href: "/contact", label: copy.nav.inquiry, icon: MessageCircle },
    { href: "/more", label: copy.nav.more, icon: Menu },
  ];
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav className="safe-bottom fixed bottom-0 left-0 z-50 w-full border-t border-white/10 bg-graphite/95 backdrop-blur-lg md:hidden" aria-label={copy.header.mobileNavigation}>
      <div className="flex min-h-[62px] items-stretch justify-around px-2">
        {tabs.map((tab) => {
          const active = isActive(tab.href);
          const Icon = tab.icon;
          return (
            <Link key={tab.href} href={localePath(locale, tab.href)} className={cn("relative flex min-h-[62px] flex-1 flex-col items-center justify-center gap-1 py-2 transition", active ? "text-gold-light" : "text-white/50")} aria-current={active ? "page" : undefined}>
              {active && <span className="absolute top-0 h-px w-8 bg-gold" />}
              <Icon className="h-5 w-5" strokeWidth={active ? 2.2 : 1.8} />
              {tab.href === "/contact" && <InquiryCountBadge className="absolute right-[calc(50%-24px)] top-1.5" />}
              <span className={cn("text-[10px]", active ? "font-semibold" : "font-medium")}>{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
