"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { BrandLogo } from "./BrandLogo";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { localePath, pathWithoutLocale, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { localizeNavItem, navigationWithProjects } from "@/lib/i18n/content";
import { cn } from "@/lib/utils";
import type { CompanyProfile, NavItem, SiteSettings } from "@/types/database";
import { InquiryCountBadge } from "./inquiry-list/InquiryCountBadge";

const defaultNavItems: NavItem[] = [
  { href: "/", label_cn: "首页", label_en: "Home" },
  { href: "/products", label_cn: "产品中心", label_en: "Products" },
  { href: "/projects", label_cn: "应用案例", label_en: "Projects" },
  { href: "/certificates", label_cn: "资质证书", label_en: "Certificates" },
  { href: "/about", label_cn: "关于我们", label_en: "About" },
  { href: "/contact", label_cn: "联系我们", label_en: "Contact" },
];

interface DesktopHeaderProps {
  company?: CompanyProfile | null;
  siteSettings?: SiteSettings | null;
  locale: Locale;
}

export function DesktopHeader({
  company,
  siteSettings,
  locale,
}: DesktopHeaderProps) {
  const pathname = pathWithoutLocale(usePathname());
  const [scrolled, setScrolled] = useState(false);
  const copy = getDictionary(locale);
  const navItems = navigationWithProjects(
    siteSettings?.navigation_json?.length
      ? siteSettings.navigation_json
      : defaultNavItems,
  );
  const isHome = pathname === "/";
  const transparentAtTop = isHome && !scrolled;
  const isActive = (href: string) =>
    href === "/"
      ? pathname === "/"
      : pathname === href || pathname.startsWith(`${href}/`);

  useEffect(() => {
    if (!isHome) {
      setScrolled(true);
      return;
    }
    const sync = () => setScrolled(window.scrollY > 24);
    sync();
    window.addEventListener("scroll", sync, { passive: true });
    return () => window.removeEventListener("scroll", sync);
  }, [isHome]);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 hidden h-16 border-b transition-[background-color,border-color,backdrop-filter,box-shadow] duration-300 lg:block",
        transparentAtTop
          ? "border-transparent bg-transparent shadow-none backdrop-blur-none"
          : "border-white/10 bg-page/[0.88] shadow-[0_8px_30px_rgba(0,0,0,0.16)] backdrop-blur-xl",
      )}
    >
      <div className="flex h-full items-center justify-between gap-5 px-8 lg:px-10 xl:px-12">
        <Link
          href={localePath(locale)}
          prefetch={false}
          className="flex shrink-0 items-center gap-3"
          aria-label={copy.header.homeAria}
        >
          <BrandLogo
            logoUrl={company?.logo_url}
            size={104}
            variant="wordmark"
            className="text-gold"
          />
          <span className="hidden whitespace-nowrap text-[10px] text-white/60 xl:inline">
            {copy.header.tagline}
          </span>
        </Link>
        <nav
          className="flex min-w-0 flex-1 items-center justify-center gap-1"
          aria-label={copy.header.primaryNavigation}
        >
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={localePath(locale, item.href)}
                prefetch={false}
                className={cn(
                  "relative px-2 py-5 text-sm font-medium transition-colors lg:px-2.5 xl:px-4",
                  active ? "text-gold" : "text-white/72 hover:text-gold",
                )}
                aria-current={active ? "page" : undefined}
              >
                {localizeNavItem(item, locale)}
              </Link>
            );
          })}
        </nav>
        <div className="flex shrink-0 items-center gap-4">
          <LanguageSwitcher
            locale={locale}
            className="text-xs text-white/72 hover:text-gold"
          />
          <Link
            href={localePath(locale, "/contact")}
            prefetch={false}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-gold px-4 text-xs font-medium text-gold transition-colors hover:bg-gold/10 hover:text-gold-light"
          >
            {copy.header.quote}
            <InquiryCountBadge className="bg-gold text-page" />
          </Link>
        </div>
      </div>
    </header>
  );
}
