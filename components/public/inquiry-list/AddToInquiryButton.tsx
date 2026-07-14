"use client";

import { Check, ListPlus } from "lucide-react";
import { useState } from "react";
import { useInquiryList } from "./InquiryListProvider";
import { cn } from "@/lib/utils";
import type { Locale } from "@/lib/i18n/config";
import type { Product } from "@/types/database";
import { trackAnalyticsEvent } from "@/lib/client/analytics";

export function AddToInquiryButton({ product, locale, className, compact = false }: { product: Product; locale: Locale; className?: string; compact?: boolean }) {
  const { add, items } = useInquiryList();
  const alreadyAdded = items.some((item) => item.product_id === product.id);
  const [justAdded, setJustAdded] = useState(false);
  const label = alreadyAdded || justAdded
    ? (locale === "zh" ? "已加入询盘" : "Added")
    : (locale === "zh" ? "加入询盘" : "Add to inquiry");
  return (
    <button
      type="button"
      onClick={() => {
        add({ product_id: product.id, slug: product.slug, name_cn: product.name_cn, name_en: product.name_en, cover_image_url: product.cover_image_url, quantity: "" });
        trackAnalyticsEvent({ event_name: "add_to_inquiry", locale, product_id: product.id });
        setJustAdded(true);
        window.setTimeout(() => setJustAdded(false), 1600);
      }}
      className={cn("inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md border border-gold/40 px-3 text-xs font-medium text-gold-dark transition hover:border-gold", compact && "min-h-9 px-2 text-[11px]", className)}
      aria-label={`${label}: ${locale === "en" ? product.name_en || product.name_cn : product.name_cn}`}
    >
      {alreadyAdded || justAdded ? <Check className="h-3.5 w-3.5" /> : <ListPlus className="h-3.5 w-3.5" />}{label}
    </button>
  );
}
