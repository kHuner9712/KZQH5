"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Globe2 } from "lucide-react";
import { BrandLogo } from "./BrandLogo";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { localePath, pathWithoutLocale, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { localizeNavItem, localizeSiteSettings, navigationWithProjects } from "@/lib/i18n/content";
import { cn } from "@/lib/utils";
import type { CompanyProfile, NavItem, SiteSettings } from "@/types/database";
import { InquiryCountBadge } from "./inquiry-list/InquiryCountBadge";

const defaultNavItems: NavItem[] = [
  { href: "/", label_cn: "首页", label_en: "Home" },
  { href: "/products", label_cn: "产品中心", label_en: "Products" },
  { href: "/projects", label_cn: "应用案例", label_en: "Projects" },
  { href: "/certificates", label_cn: "资质证书", label_en: "Certificates" },
  { href: "/about", label_cn: "关于我们", label_en: "About" },
  { href: "/contact", label_cn: "联系询盘", label_en: "Inquiry" },
];

export function DesktopHeader({
  company,
  siteSettings,
  locale,
}: {
  company?: CompanyProfile | null;
  siteSettings?: SiteSettings | null;
  locale: Locale;
}) {
  const pathname = pathWithoutLocale(usePathname());
  const copy = getDictionary(locale);
  const settings = localizeSiteSettings(siteSettings, locale);
  const navItems = navigationWithProjects(siteSettings?.navigation_json?.length
    ? siteSettings.navigation_json
    : defaultNavItems);
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="sticky top-0 z-40 hidden border-b border-white/10 bg-graphite/95 backdrop-blur-lg md:block">
      <div className="container-responsive flex h-16 items-center justify-between gap-7">
        <Link href={localePath(locale)} className="flex shrink-0 items-center gap-3" aria-label={copy.header.homeAria}>
          <BrandLogo logoUrl={company?.logo_url} size={36} className="rounded-md border border-gold/[0.35] bg-transparent text-gold" />
          <div className="leading-tight">
            <p className="text-base font-semibold tracking-[0.08em] text-white">{siteSettings?.brand_name || settings.siteName}</p>
            <p className="mt-1 text-[8px] uppercase tracking-[0.2em] text-white/[0.45]">{copy.header.tagline}</p>
          </div>
        </Link>
        <nav className="flex min-w-0 flex-1 items-center justify-center gap-0.5" aria-label={copy.header.primaryNavigation}>
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link key={item.href} href={localePath(locale, item.href)} className={cn("relative px-3 py-[18px] text-[13px] font-medium transition-colors xl:px-4", active ? "text-gold-light" : "text-white/[0.65] hover:text-white")} aria-current={active ? "page" : undefined}>
                {localizeNavItem(item, locale)}
                {active && <span className="absolute bottom-2.5 left-1/2 h-px w-7 -translate-x-1/2 bg-gold" />}
              </Link>
            );
          })}
        </nav>
        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-white/50 lg:inline-flex"><Globe2 className="h-3.5 w-3.5" /></span>
          <LanguageSwitcher locale={locale} className="text-white/70 hover:text-gold-light" />
          <Link href={localePath(locale, "/contact")} className="btn-primary h-9 px-4 text-[12px]">{copy.header.quote}<InquiryCountBadge className="bg-page text-gold-light" /></Link>
        </div>
      </div>
    </header>
  );
}
