"use client";

import Link from "next/link";
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
  const copy = getDictionary(locale);
  const navItems = navigationWithProjects(
    siteSettings?.navigation_json?.length
      ? siteSettings.navigation_json
      : defaultNavItems,
  );
  const isActive = (href: string) =>
    href === "/"
      ? pathname === "/"
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="fixed inset-x-0 top-0 z-50 hidden h-16 border-b border-white/10 bg-page/[0.85] backdrop-blur-xl md:block">
      <div className="flex h-full items-center justify-between gap-6 px-8 lg:px-12">
        <Link
          href={localePath(locale)}
          className="flex shrink-0 items-center gap-2"
          aria-label={copy.header.homeAria}
        >
          <BrandLogo
            logoUrl={company?.logo_url}
            size={54}
            variant="wordmark"
            className="text-gold"
          />
          <span className="text-[10px] text-white/45">
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
                className={cn(
                  "relative px-2 py-5 text-sm font-medium transition-colors lg:px-3 xl:px-4",
                  active ? "text-gold" : "text-ink-mute hover:text-gold",
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
            className="text-xs text-ink-mute hover:text-gold"
          />
          <Link
            href={localePath(locale, "/contact")}
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
