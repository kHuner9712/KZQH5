"use client";

import { useEffect } from "react";
import Link from "next/link";
import { getDictionary } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/config";
import { localePath } from "@/lib/i18n/config";

export function PublicError({ locale, error, reset }: { locale: Locale; error: Error & { digest?: string }; reset: () => void }) {
  const copy = getDictionary(locale).errors;
  useEffect(() => { console.error(error); }, [error]);
  return <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center" role="alert"><h1 className="text-xl font-semibold text-ink">{copy.title}</h1><p className="mt-2 max-w-md text-sm leading-6 text-ink-mute">{copy.description}</p><div className="mt-6 flex flex-wrap justify-center gap-3"><button type="button" onClick={reset} className="btn-primary h-11 px-6">{getDictionary(locale).common.retry}</button><Link href={localePath(locale)} className="btn-outline h-11 px-5">{copy.backHome}</Link><Link href={localePath(locale, "/products")} className="btn-outline h-11 px-5">{locale === "zh" ? "产品中心" : "Products"}</Link></div></div>;
}
