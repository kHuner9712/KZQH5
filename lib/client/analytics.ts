import { readInquiryAttribution } from "@/lib/client/inquiry-attribution";
import type { Locale } from "@/lib/i18n/config";
import type { AnalyticsEventName } from "@/types/database";

export interface BrowserAnalyticsEvent {
  event_name: AnalyticsEventName;
  locale?: Locale;
  page_path?: string;
  product_id?: string | null;
  project_id?: string | null;
}

export function trackAnalyticsEvent(event: BrowserAnalyticsEvent): void {
  if (typeof window === "undefined") return;
  try {
    const attribution = readInquiryAttribution();
    const payload = JSON.stringify({
      ...event,
      locale: event.locale || (window.location.pathname.startsWith("/en") ? "en" : "zh"),
      page_path: event.page_path || `${window.location.pathname}${window.location.search}`,
      source: attribution.source,
      channel: attribution.channel,
      utm_source: attribution.utm_source,
      utm_medium: attribution.utm_medium,
      utm_campaign: attribution.utm_campaign,
      referrer: attribution.referrer || document.referrer || undefined,
    });
    const blob = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon?.("/api/analytics/events", blob)) return;
    void fetch("/api/analytics/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => undefined);
  } catch {
    // 统计失败绝不阻断导航、复制、拨号或表单提交。
  }
}
