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
      // prefetch={false}: the floating inquiry bar is present on every
      // public list page (products, projects, home, etc.). App Router
      // prefetches /contact on viewport entry. When the user clicks a
      // product card, the Router cancels this in-flight prefetch
      // (net::ERR_ABORTED); in rare cases the cancellation cascade
      // also aborts the click-triggered product-detail RSC request.
      // Disabling prefetch eliminates this race without affecting the
      // tap-driven navigation behavior.
      prefetch={false}
      className="fixed right-4 z-40 inline-flex h-12 w-12 items-center justify-center rounded-full bg-gold text-page shadow-[0_4px_16px_rgba(197,161,90,0.30)] transition hover:bg-gold-light md:hidden"
      style={{ bottom: "calc(56px + env(safe-area-inset-bottom) + 12px)" }}
      aria-label={getDictionary(locale).home.inquiry}
    >
      <MessageSquareText className="h-5 w-5" />
    </Link>
  );
}
