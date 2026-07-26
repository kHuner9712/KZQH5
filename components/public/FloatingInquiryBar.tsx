"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageSquareText } from "lucide-react";
import { localePath, pathWithoutLocale, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";

export function FloatingInquiryBar({ locale = "zh" }: { locale?: Locale }) {
  const pathname = pathWithoutLocale(usePathname());
  if (pathname === "/contact" || pathname.startsWith("/products/")) return null;

  return (
    <Link
      href={localePath(locale, "/contact")}
      className="fixed right-4 z-40 inline-flex h-12 w-12 items-center justify-center rounded-full bg-gold text-page shadow-[0_4px_16px_rgba(197,161,90,0.30)] transition hover:bg-gold-light md:hidden"
      style={{ bottom: "calc(56px + env(safe-area-inset-bottom) + 12px)" }}
      aria-label={getDictionary(locale).home.inquiry}
    >
      <MessageSquareText className="h-5 w-5" />
    </Link>
  );
}
