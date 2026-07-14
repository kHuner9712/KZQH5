"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { localePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";

function SearchBoxInner({ locale }: { locale: Locale }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [q, setQ] = useState(searchParams.get("q") || "");
  const copy = getDictionary(locale);
  useEffect(() => setQ(searchParams.get("q") || ""), [searchParams]);
  function submit(value: string) { const params = new URLSearchParams(searchParams.toString()); value.trim() ? params.set("q", value.trim()) : params.delete("q"); params.delete("page"); const query = params.toString(); router.push(`${localePath(locale, "/products")}${query ? `?${query}` : ""}`); }
  return <div className="relative"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute" /><input type="search" value={q} onChange={(event) => setQ(event.target.value)} onKeyDown={(event) => event.key === "Enter" && submit(q)} placeholder={copy.products.search} aria-label={copy.products.search} className="h-11 w-full rounded-xl border border-ink-line bg-white pl-10 pr-10 text-sm text-ink outline-none transition placeholder:text-ink-mute focus:border-industrial focus:ring-2 focus:ring-industrial/15" />{q && <button type="button" onClick={() => { setQ(""); submit(""); }} className="absolute right-3.5 top-1/2 min-h-9 min-w-9 -translate-y-1/2 text-ink-mute hover:text-ink" aria-label={copy.common.clear}><X className="mx-auto h-4 w-4" /></button>}</div>;
}

export function SearchBox({ locale = "zh" }: { locale?: Locale }) { return <Suspense fallback={<div className="h-11 rounded-xl border border-ink-line bg-white" />}><SearchBoxInner locale={locale} /></Suspense>; }
