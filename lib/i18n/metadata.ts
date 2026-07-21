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
 * once. This is the ONLY title transformation — we deliberately do NOT
 * detect whether the title "contains KZQ" elsewhere, because product names
 * like "KZQ WPC Wall Panel" would then incorrectly bypass the template
 * and lose the brand suffix entirely.
 *
 * The home page is the single exception: it uses `{ absolute }` directly
 * in its own metadata (see `app/(public)/page.tsx`) because its title is
 * the full brand statement, not a page name that needs a suffix.
 */
function stripTrailingBrand(title: string): string {
  return title.replace(/\s*\|\s*KZQ\s*$/i, "").trim();
}

export function buildLocalizedMetadata({
  locale,
  path,
  title,
  description,
  image,
  absolute = false,
}: {
  locale: Locale;
  path: string;
  title: string;
  description: string;
  image?: string | null;
  /**
   * When true, the title is returned as `{ absolute: title }` so the root
   * layout's `template: "%s | KZQ"` does NOT append "| KZQ". Use this only
   * for the home page, whose title is already the full brand statement
   * (e.g. "KZQ | Engineering Board Brand"). Sub-pages should leave this
   * false so the template appends the brand suffix exactly once.
   */
  absolute?: boolean;
}): Metadata {
  const canonical = siteUrl(localePath(locale, path));
  // Strip any trailing "| KZQ" so the root layout's `template: "%s | KZQ"`
  // appends the brand exactly once. We do NOT bypass the template based on
  // whether the title mentions KZQ — that would be unpredictable for
  // product names that happen to contain the brand.
  const cleaned = stripTrailingBrand(title);
  // Home page bypasses the template because its title is already a full
  // brand statement (e.g. "KZQ | Engineering Board Brand").
  const htmlTitle: string | { absolute: string } = absolute
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
