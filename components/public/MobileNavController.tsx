"use client";

import { usePathname } from "next/navigation";
import { pathWithoutLocale, type Locale } from "@/lib/i18n/config";
import { BottomNav } from "./BottomNav";

export function MobileNavController({ locale }: { locale: Locale }) {
  const pathname = pathWithoutLocale(usePathname());
  if (pathname.startsWith("/products/")) return null;
  return <BottomNav locale={locale} />;
}
