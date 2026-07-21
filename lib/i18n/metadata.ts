import type { Metadata } from "next";
import { siteUrl } from "@/lib/utils";
import { localeConfig, localePath, type Locale } from "./config";

export function localizedAlternates(path: string) {
  return {
    "zh-CN": siteUrl(localePath("zh", path)),
    en: siteUrl(localePath("en", path)),
    "x-default": siteUrl(localePath("zh", path)),
  };
}

/**
 * Strips a trailing "| KZQ" suffix (case-insensitive, ignoring outer
 * whitespace) from a page-level title.
 *
 * Why: the root layout applies `template: "%s | KZQ"` to every child page
 * title. If a CMS-stored seo_title or a hand-written page title already
 * ends with "| KZQ", the rendered HTML <title> would become
 * "X | KZQ | KZQ" — a duplicate brand suffix.
 *
 * Stripping the trailing brand here lets the template append it exactly
 * once. The OG / Twitter titles below are NOT affected (they always use
 * the original title verbatim).
 */
function stripTrailingBrand(title: string): string {
  return title.replace(/\s*\|\s*KZQ\s*$/i, "").trim();
}

/**
 * Returns true when a page-level title already mentions the brand "KZQ".
 *
 * When true, `buildLocalizedMetadata` returns the title as
 * `{ absolute: title }` so the root layout's `template: "%s | KZQ"` does
 * NOT append another "| KZQ" — the brand is already present and the
 * template would only create a duplicate.
 *
 * Examples:
 *   - "产品目录与色卡" → false → templated → "产品目录与色卡 | KZQ"
 *   - "About KZQ | Engineering Board Brand" → true → absolute (no template)
 *   - "KZQ | 工程级板材" → true → absolute (no template)
 */
function titleContainsBrand(title: string): boolean {
  return /\bKZQ\b/i.test(title);
}

export function buildLocalizedMetadata({
  locale,
  path,
  title,
  description,
  image,
}: {
  locale: Locale;
  path: string;
  title: string;
  description: string;
  image?: string | null;
}): Metadata {
  const canonical = siteUrl(localePath(locale, path));
  // The HTML <title> after template application. We strip any trailing
  // "| KZQ" first so the template can append it exactly once. If the title
  // already mentions KZQ anywhere, we bypass the template entirely by
  // returning `{ absolute }` — otherwise the brand would appear twice.
  const cleaned = stripTrailingBrand(title);
  const htmlTitle: string | { absolute: string } = titleContainsBrand(cleaned)
    ? { absolute: cleaned }
    : cleaned;
  // OG / Twitter titles are the absolute, fully-formed title (no template
  // applies to social share previews).
  const ogTitle = cleaned;
  const ogParams = new URLSearchParams({ locale, title: ogTitle.slice(0, 90) });
  const shareImage = image || siteUrl(`/api/og?${ogParams.toString()}`);
  return {
    title: htmlTitle,
    description,
    alternates: {
      canonical,
      languages: localizedAlternates(path),
    },
    openGraph: {
      title: ogTitle,
      description,
      url: canonical,
      locale: localeConfig[locale].ogLocale,
      alternateLocale: [localeConfig[locale === "en" ? "zh" : "en"].ogLocale],
      type: "website",
      images: [{ url: shareImage, width: 1200, height: 630, alt: ogTitle }],
    },
    twitter: { card: "summary_large_image", title: ogTitle, description, images: [shareImage] },
    robots: { index: true, follow: true },
  };
}
