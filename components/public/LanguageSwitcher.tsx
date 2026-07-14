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
  return <Link href={href} hrefLang={localeConfig[target].htmlLang} className={cn("inline-flex min-h-9 items-center text-xs font-medium", className)} aria-label={copy.header.switchLanguage}>{copy.header.languageShort}</Link>;
}

export function LanguageSwitcher({ locale, className }: { locale: Locale; className?: string }) {
  return <Suspense fallback={<span className={cn("inline-flex min-h-9 items-center text-xs font-medium", className)}>{getDictionary(locale).header.languageShort}</span>}><LanguageSwitcherInner locale={locale} className={className} /></Suspense>;
}
