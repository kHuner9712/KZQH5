import type { HomeHeroSlide } from "@/types/homepage";

export type HomeHeroSlideValidationResult =
  | { ok: true; value: HomeHeroSlide[] }
  | { ok: false; error: string };

function optionalString(value: unknown, maxLength: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("not-string");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) throw new Error("too-long");
  return trimmed;
}

function numberInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function isSafeImageUrl(value: string): boolean {
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function safeInternalHref(value: string | null, fallback: string): string {
  if (!value) return fallback;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  if (value.startsWith("#")) return value;
  throw new Error("invalid-href");
}

export function validateHomeHeroSlideArray(
  value: unknown,
  maxItems = 5,
): HomeHeroSlideValidationResult {
  if (value == null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: "hero_slides:not-array" };
  if (value.length > maxItems) {
    return { ok: false, error: "hero_slides:too-many-items" };
  }

  const slides: HomeHeroSlide[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `hero_slides:item-${index}-not-object` };
    }

    const source = item as Record<string, unknown>;
    try {
      const enabled = typeof source.enabled === "boolean" ? source.enabled : true;
      const desktopImageUrl = optionalString(source.desktop_image_url, 2048) ?? "";
      const mobileImageUrl = optionalString(source.mobile_image_url, 2048);
      if (enabled && !desktopImageUrl) {
        return { ok: false, error: `hero_slides:item-${index}-missing-desktop-image` };
      }
      if (desktopImageUrl && !isSafeImageUrl(desktopImageUrl)) {
        return { ok: false, error: `hero_slides:item-${index}-invalid-desktop-image` };
      }
      if (mobileImageUrl && !isSafeImageUrl(mobileImageUrl)) {
        return { ok: false, error: `hero_slides:item-${index}-invalid-mobile-image` };
      }

      slides.push({
        id: optionalString(source.id, 100) ?? `slide-${index + 1}`,
        enabled,
        desktop_image_url: desktopImageUrl,
        mobile_image_url: mobileImageUrl,
        alt_cn: optionalString(source.alt_cn, 300),
        alt_en: optionalString(source.alt_en, 300),
        eyebrow_cn: optionalString(source.eyebrow_cn, 200),
        eyebrow_en: optionalString(source.eyebrow_en, 200),
        title_cn: optionalString(source.title_cn, 300),
        title_en: optionalString(source.title_en, 300),
        highlight_cn: optionalString(source.highlight_cn, 300),
        highlight_en: optionalString(source.highlight_en, 300),
        description_cn: optionalString(source.description_cn, 1200),
        description_en: optionalString(source.description_en, 1200),
        primary_cta_text_cn: optionalString(source.primary_cta_text_cn, 100),
        primary_cta_text_en: optionalString(source.primary_cta_text_en, 100),
        primary_cta_href: safeInternalHref(
          optionalString(source.primary_cta_href, 500),
          "/products",
        ),
        secondary_cta_text_cn: optionalString(source.secondary_cta_text_cn, 100),
        secondary_cta_text_en: optionalString(source.secondary_cta_text_en, 100),
        secondary_cta_href: safeInternalHref(
          optionalString(source.secondary_cta_href, 500),
          "/contact",
        ),
        focal_x: numberInRange(source.focal_x, 50, 0, 100),
        focal_y: numberInRange(source.focal_y, 50, 0, 100),
        overlay_opacity: numberInRange(source.overlay_opacity, 0.42, 0.2, 0.82),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "invalid";
      return { ok: false, error: `hero_slides:item-${index}-${reason}` };
    }
  }

  return { ok: true, value: slides };
}
