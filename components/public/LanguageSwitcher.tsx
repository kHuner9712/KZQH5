"use client";

import Link from "next/link";
import { Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { alternateLocale, localeConfig, switchLocalePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { cn } from "@/lib/utils";

function LanguageSwitcherInner({ locale, className }: { locale: Locale; className?: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const target = alternateLocale(locale);
  const query = searchParams.toString();
  const href = `${switchLocalePath(pathname, target)}${query ? `?${query}` : ""}`;
  const copy = getDictionary(locale);
  // prefetch={false}: the locale switcher link points to the alternate
  // locale's version of the CURRENT page (e.g. /en/products?... while on
  // /products?...). App Router prefetches this link on every page render.
  // When the user clicks a product card (or any in-page navigation), the
  // Router cancels the in-flight locale-switch prefetch (net::ERR_ABORTED).
  // In rare cases the cancellation cascade also aborts the
  // click-triggered RSC request, leaving the user stuck on the current
  // page. Disabling prefetch on the switcher eliminates this race without
  // affecting the click-driven locale switch behavior.
  return <Link href={href} hrefLang={localeConfig[target].htmlLang} prefetch={false} className={cn("inline-flex min-h-9 items-center text-xs font-medium", className)} aria-label={copy.header.switchLanguage}>{copy.header.languageShort}</Link>;
}

export function LanguageSwitcher({ locale, className }: { locale: Locale; className?: string }) {
  return <Suspense fallback={<span className={cn("inline-flex min-h-9 items-center text-xs font-medium", className)}>{getDictionary(locale).header.languageShort}</span>}><LanguageSwitcherInner locale={locale} className={className} /></Suspense>;
}
