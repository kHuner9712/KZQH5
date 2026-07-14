"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { localePath, pathWithoutLocale, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";

export function FloatingInquiryBar({ locale = "zh" }: { locale?: Locale }) {
  const pathname = pathWithoutLocale(usePathname());
  if (pathname === "/contact" || pathname.startsWith("/products/")) return null;
  return <Link href={localePath(locale, "/contact")} className="fixed bottom-20 left-1/2 z-40 w-full max-w-h5 -translate-x-1/2 px-4"><div className="flex justify-end"><span className="flex items-center gap-1.5 rounded-full bg-industrial px-4 py-2.5 text-[12px] font-medium text-white shadow-lg"><MessageCircle className="h-4 w-4" />{getDictionary(locale).home.inquiry}</span></div></Link>;
}
