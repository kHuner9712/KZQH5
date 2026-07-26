"use client";

import Link from "next/link";
import { Ellipsis } from "lucide-react";
import { BrandLogo } from "./BrandLogo";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { localePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import type { CompanyProfile, SiteSettings } from "@/types/database";

interface MobileHeaderProps {
  company?: CompanyProfile | null;
  siteSettings?: SiteSettings | null;
  locale: Locale;
}

export function MobileHeader({ company, locale }: MobileHeaderProps) {
  const copy = getDictionary(locale);

  return (
    <header className="fixed inset-x-0 top-0 z-50 h-12 border-b border-white/10 bg-page/90 backdrop-blur-xl lg:hidden">
      <div className="flex h-full items-center justify-between px-4">
        <Link
          href={localePath(locale)}
          className="flex min-w-0 items-center gap-1.5"
          aria-label={copy.header.homeAria}
        >
          <BrandLogo
            logoUrl={company?.logo_url}
            size={48}
            variant="wordmark"
            className="text-gold"
          />
          <span className="truncate text-[10px] text-white/60">
            {copy.header.mobileTagline}
          </span>
        </Link>
        <div className="flex items-center gap-1">
          <Link
            href={localePath(locale, "/more")}
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
