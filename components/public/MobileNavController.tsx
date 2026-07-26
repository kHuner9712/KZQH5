"use client";

import { usePathname } from "next/navigation";
import { pathWithoutLocale, type Locale } from "@/lib/i18n/config";
import { BottomNav } from "./BottomNav";
import { FloatingInquiryBar } from "./FloatingInquiryBar";

export function MobileNavController({ locale }: { locale: Locale }) {
  const pathname = pathWithoutLocale(usePathname());
  if (pathname.startsWith("/products/")) return null;

  return (
    <>
      <FloatingInquiryBar locale={locale} />
      <BottomNav locale={locale} />
    </>
  );
}
