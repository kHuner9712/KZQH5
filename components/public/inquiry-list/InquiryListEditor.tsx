"use client";

import { ListChecks, Trash2, X } from "lucide-react";
import { ProductImage } from "@/components/public/ProductImage";
import { useInquiryList } from "./InquiryListProvider";
import type { Locale } from "@/lib/i18n/config";

export function InquiryListEditor({ locale }: { locale: Locale }) {
  const { items, loaded, remove, updateQuantity, clear } = useInquiryList();
  const labels = locale === "zh"
    ? { title: "询盘清单", empty: "尚未选择产品，也可以直接在下方手动填写产品。", quantity: "需求数量", clear: "清空清单", remove: "删除" }
    : { title: "Inquiry List", empty: "No products selected. You can enter a product manually below.", quantity: "Required quantity", clear: "Clear list", remove: "Remove" };
  if (!loaded) return <div className="h-20 animate-pulse rounded-lg bg-canvas-warm" />;
  return (
    <section className="mb-6 rounded-lg border border-ink-line bg-canvas-warm p-4" aria-labelledby="inquiry-list-title">
      <div className="flex items-center justify-between gap-3">
        <h3 id="inquiry-list-title" className="flex items-center gap-2 text-sm font-semibold text-ink"><ListChecks className="h-4 w-4 text-gold-dark" />{labels.title}{items.length > 0 && <span className="text-xs font-normal text-ink-mute">({items.length})</span>}</h3>
        {items.length > 0 && <button type="button" onClick={clear} className="inline-flex min-h-9 items-center gap-1 text-xs text-ink-mute hover:text-red-600"><Trash2 className="h-3.5 w-3.5" />{labels.clear}</button>}
      </div>
      {!items.length ? <p className="mt-3 text-xs leading-5 text-ink-mute">{labels.empty}</p> : <div className="mt-3 space-y-3">{items.map((item) => {
        const name = locale === "en" ? item.name_en || item.name_cn : item.name_cn;
        return <div key={item.product_id} className="grid grid-cols-[64px_1fr_auto] gap-3 border-t border-ink-line pt-3 first:border-0 first:pt-0">
          <div className="h-16 overflow-hidden rounded-md"><ProductImage src={item.cover_image_url} alt={name} sizes="64px" /></div>
          <div className="min-w-0"><p className="line-clamp-2 text-xs font-medium text-ink">{name}</p><p className="mt-0.5 truncate text-[10px] text-ink-mute">{item.slug}</p><label className="mt-2 block text-[10px] text-ink-mute"><span className="sr-only">{labels.quantity}</span><input value={item.quantity} onChange={(event) => updateQuantity(item.product_id, event.target.value)} placeholder={labels.quantity} className="h-9 w-full rounded-md border border-ink-line bg-white px-2 text-xs text-ink outline-none focus:border-gold" /></label></div>
          <button type="button" onClick={() => remove(item.product_id)} className="flex h-9 w-9 items-center justify-center rounded-md text-ink-mute hover:bg-red-50 hover:text-red-600" aria-label={`${labels.remove}: ${name}`}><X className="h-4 w-4" /></button>
        </div>;
      })}</div>}
    </section>
  );
}

