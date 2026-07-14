"use client";

import { Check, Copy, Phone } from "lucide-react";
import { useState } from "react";
import { copyText } from "@/lib/client/copy-text";
import type { Locale } from "@/lib/i18n/config";
import { trackAnalyticsEvent } from "@/lib/client/analytics";

export function ContactQuickActions({ phone, wechat, locale }: { phone?: string | null; wechat?: string | null; locale: Locale }) {
  const [copied, setCopied] = useState<"phone" | "wechat" | null>(null);

  async function copy(value: string, field: "phone" | "wechat") {
    const success = await copyText(value);
    if (!success) return;
    trackAnalyticsEvent({ event_name: field === "wechat" ? "wechat_copy" : "phone_click", locale });
    setCopied(field);
    window.setTimeout(() => setCopied(null), 1800);
  }

  if (!phone && !wechat) return null;
  const labels = locale === "zh"
    ? { call: "一键拨号", phone: "复制手机号", wechat: "复制微信号", copied: "复制成功" }
    : { call: "Call", phone: "Copy phone", wechat: "Copy WeChat", copied: "Copied" };

  return (
    <div className="mt-3 flex flex-wrap gap-2" aria-live="polite">
      {phone && <a href={`tel:${phone.replace(/[^+\d]/g, "")}`} onClick={() => trackAnalyticsEvent({ event_name: "phone_click", locale })} className="btn-outline h-10 px-3 text-xs"><Phone className="h-3.5 w-3.5" />{labels.call}</a>}
      {phone && <button type="button" onClick={() => copy(phone, "phone")} className="btn-outline h-10 px-3 text-xs">{copied === "phone" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied === "phone" ? labels.copied : labels.phone}</button>}
      {wechat && <button type="button" onClick={() => copy(wechat, "wechat")} className="btn-outline h-10 px-3 text-xs">{copied === "wechat" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied === "wechat" ? labels.copied : labels.wechat}</button>}
    </div>
  );
}
