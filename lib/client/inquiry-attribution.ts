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

export function mergeInquiryAttribution({
  existing,
  search,
  referrer,
  origin,
}: {
  existing: Attribution;
  search: string;
  referrer?: string;
  origin: string;
}): Attribution {
  const params = new URLSearchParams(search);
  const next: Attribution = { ...existing };
  KEYS.forEach((key) => {
    const candidate = params.get(key)?.trim();
    const preserveExistingSource =
      key === "source" &&
      candidate === "direct" &&
      existing.source &&
      existing.source !== "direct";
    if (candidate && !preserveExistingSource)
      next[key] = candidate.slice(0, 200);
  });
  const safeReferrer = next.referrer || referrer?.slice(0, 1000) || undefined;
  if (safeReferrer && !next.referrer) next.referrer = safeReferrer;

  const explicitSource = params.get("source")?.trim();
  const campaignSource = params.get("utm_source")?.trim();
  const explicitChannel = params.get("channel")?.trim();
  const campaignChannel = params.get("utm_medium")?.trim();
  if (explicitSource && explicitSource !== "direct") {
    next.source = explicitSource.slice(0, 80);
  } else if (!next.source || next.source === "direct") {
    let derivedSource = campaignSource;
    if (!derivedSource && safeReferrer) {
      try {
        const referrerUrl = new URL(safeReferrer);
        if (referrerUrl.origin !== origin) derivedSource = referrerUrl.hostname;
      } catch {
        // 非法 referrer 不参与来源推导。
      }
    }
    next.source = (derivedSource || next.source || "direct").slice(0, 80);
  }
  if (explicitChannel) next.channel = explicitChannel.slice(0, 80);
  else if (!next.channel && campaignChannel)
    next.channel = campaignChannel.slice(0, 80);
  return next;
}

export function captureInquiryAttribution(): void {
  try {
    const existing = readInquiryAttribution();
    const next = mergeInquiryAttribution({
      existing,
      search: window.location.search,
      referrer: document.referrer,
      origin: window.location.origin,
    });
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
    return parsed && typeof parsed === "object" ? (parsed as Attribution) : {};
  } catch {
    return {};
  }
}
