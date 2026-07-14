import type { InquiryInput } from "@/types/database";

const STORAGE_KEY = "kzq-inquiry-attribution-v1";
const KEYS = [
  "source",
  "channel",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

type Attribution = Pick<InquiryInput, (typeof KEYS)[number] | "referrer">;

export function captureInquiryAttribution(): void {
  try {
    const existing = readInquiryAttribution();
    const params = new URLSearchParams(window.location.search);
    const next: Attribution = { ...existing };
    KEYS.forEach((key) => {
      const candidate = params.get(key)?.trim();
      if (candidate) next[key] = candidate.slice(0, 200);
    });
    const referrer = next.referrer || document.referrer.slice(0, 1000) || undefined;
    if (referrer && !next.referrer) next.referrer = referrer;

    // 保留首次非 direct 来源；若当前访问带显式 source/UTM，则补齐来源与渠道。
    const explicitSource = params.get("source")?.trim();
    const campaignSource = params.get("utm_source")?.trim();
    const explicitChannel = params.get("channel")?.trim();
    const campaignChannel = params.get("utm_medium")?.trim();
    if (explicitSource) {
      next.source = explicitSource.slice(0, 80);
    } else if (!next.source || next.source === "direct") {
      let derivedSource = campaignSource;
      if (!derivedSource && referrer) {
        try {
          const referrerUrl = new URL(referrer);
          if (referrerUrl.origin !== window.location.origin) derivedSource = referrerUrl.hostname;
        } catch {
          // 非法 referrer 不参与来源推导。
        }
      }
      next.source = (derivedSource || "direct").slice(0, 80);
    }
    if (explicitChannel) next.channel = explicitChannel.slice(0, 80);
    else if (!next.channel && campaignChannel) next.channel = campaignChannel.slice(0, 80);
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式或禁用存储时不阻止页面与询盘表单运行。
  }
}

export function readInquiryAttribution(): Attribution {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Attribution : {};
  } catch {
    return {};
  }
}
