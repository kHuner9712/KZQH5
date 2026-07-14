import {
  analyticsEventNames,
  type AnalyticsEventInput,
  type AnalyticsEventName,
} from "@/types/database";

const eventNameSet = new Set<string>(analyticsEventNames);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum);
  return cleaned || null;
}

function safePagePath(value: unknown): string | null {
  const raw = optionalText(value, 1000);
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  try {
    const parsed = new URL(raw, "https://kzq.invalid");
    const safe = new URLSearchParams();
    for (const key of ["q", "category", "subcategory"]) {
      const candidate = parsed.searchParams.get(key)?.trim();
      if (candidate) safe.set(key, candidate.slice(0, 200));
    }
    const query = safe.toString();
    return `${parsed.pathname}${query ? `?${query}` : ""}`.slice(0, 1000);
  } catch {
    return null;
  }
}

function safeReferrer(value: unknown): string | null {
  const raw = optionalText(value, 1000);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.origin}${parsed.pathname}`.slice(0, 1000);
  } catch {
    return null;
  }
}

function optionalUuid(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return undefined;
  return value;
}

export type AnalyticsValidationResult =
  | { success: true; event: AnalyticsEventInput }
  | { success: false; error: string };

export function validateAnalyticsEvent(input: unknown): AnalyticsValidationResult {
  if (!input || typeof input !== "object") {
    return { success: false, error: "Invalid event payload" };
  }
  const value = input as Record<string, unknown>;
  if (typeof value.event_name !== "string" || !eventNameSet.has(value.event_name)) {
    return { success: false, error: "Invalid event_name" };
  }
  const pagePath = safePagePath(value.page_path);
  if (!pagePath) {
    return { success: false, error: "Invalid page_path" };
  }
  const productId = optionalUuid(value.product_id);
  const projectId = optionalUuid(value.project_id);
  if (productId === undefined || projectId === undefined) {
    return { success: false, error: "Invalid entity id" };
  }

  return {
    success: true,
    event: {
      event_name: value.event_name as AnalyticsEventName,
      locale: value.locale === "en" ? "en" : "zh",
      page_path: pagePath,
      product_id: productId,
      project_id: projectId,
      source: optionalText(value.source, 200),
      channel: optionalText(value.channel, 200),
      utm_source: optionalText(value.utm_source, 200),
      utm_medium: optionalText(value.utm_medium, 200),
      utm_campaign: optionalText(value.utm_campaign, 200),
      referrer: safeReferrer(value.referrer),
    },
  };
}
