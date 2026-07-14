"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { BrandLogo } from "./BrandLogo";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { localePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { localizeSiteSettings } from "@/lib/i18n/content";
import type { CompanyProfile, SiteSettings } from "@/types/database";
import { InquiryCountBadge } from "./inquiry-list/InquiryCountBadge";

export function MobileHeader({ company, siteSettings, locale }: { company?: CompanyProfile | null; siteSettings?: SiteSettings | null; locale: Locale }) {
  const copy = getDictionary(locale);
  const settings = localizeSiteSettings(siteSettings, locale);
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-graphite/95 backdrop-blur-md md:hidden">
      <div className="flex h-14 items-center justify-between gap-2 px-4">
        <Link href={localePath(locale)} className="flex min-w-0 items-center gap-2.5" aria-label={copy.header.homeAria}>
          <BrandLogo logoUrl={company?.logo_url} size={34} className="rounded-md border border-gold/30 bg-transparent text-gold" />
          <div className="min-w-0 leading-none">
            <p className="truncate text-sm font-semibold tracking-[0.08em] text-white">{siteSettings?.brand_name || settings.siteName}</p>
            <p className="mt-1 truncate text-[8px] uppercase tracking-[0.2em] text-white/[0.45]">{copy.header.mobileTagline}</p>
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <LanguageSwitcher locale={locale} className="px-1 text-white/65" />
          <Link href={localePath(locale, "/contact")} className="inline-flex h-9 items-center gap-1 rounded-md border border-gold/[0.45] px-2.5 text-[11px] font-medium text-gold-light">
            {copy.header.quickInquiry}<InquiryCountBadge /><ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </header>
  );
}
