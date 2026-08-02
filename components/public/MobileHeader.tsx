"use client";

import Link from "next/link";
import { Ellipsis } from "lucide-react";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { BrandLogo } from "./BrandLogo";
import { LanguageSwitcher } from "./LanguageSwitcher";
import {
  localePath,
  pathWithoutLocale,
  type Locale,
} from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { cn } from "@/lib/utils";
import type { CompanyProfile, SiteSettings } from "@/types/database";

interface MobileHeaderProps {
  company?: CompanyProfile | null;
  siteSettings?: SiteSettings | null;
  locale: Locale;
}

export function MobileHeader({ company, locale }: MobileHeaderProps) {
  const pathname = pathWithoutLocale(usePathname());
  const [scrolled, setScrolled] = useState(false);
  const copy = getDictionary(locale);
  const isHome = pathname === "/";
  const transparentAtTop = isHome && !scrolled;

  useEffect(() => {
    if (!isHome) {
      setScrolled(true);
      return;
    }
    const sync = () => setScrolled(window.scrollY > 16);
    sync();
    window.addEventListener("scroll", sync, { passive: true });
    return () => window.removeEventListener("scroll", sync);
  }, [isHome]);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 h-12 border-b transition-[background-color,border-color,backdrop-filter,box-shadow] duration-300 lg:hidden",
        transparentAtTop
          ? "border-transparent bg-transparent shadow-none backdrop-blur-none"
          : "border-white/10 bg-page/90 shadow-[0_8px_24px_rgba(0,0,0,0.16)] backdrop-blur-xl",
      )}
    >
      <div className="flex h-full items-center justify-between px-3.5">
        <Link
          href={localePath(locale)}
          prefetch={false}
          className="flex min-w-0 items-center"
          aria-label={copy.header.homeAria}
        >
          <BrandLogo
            logoUrl={company?.logo_url}
            size={86}
            variant="wordmark"
            className="text-gold"
          />
        </Link>
        <div className="flex items-center gap-0.5">
          <Link
            href={localePath(locale, "/more")}
            prefetch={false}
            className="inline-flex h-11 w-11 items-center justify-center text-white"
            aria-label={copy.nav.more}
          >
            <Ellipsis className="h-6 w-6" />
          </Link>
          <LanguageSwitcher
            locale={locale}
            className="inline-flex min-h-11 items-center px-1 text-xs font-semibold text-gold"
          />
        </div>
      </div>
    </header>
  );
}
