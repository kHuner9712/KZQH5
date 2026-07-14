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
  const ogParams = new URLSearchParams({ locale, title: title.slice(0, 90) });
  const shareImage = image || siteUrl(`/api/og?${ogParams.toString()}`);
  return {
    title,
    description,
    alternates: {
      canonical,
      languages: localizedAlternates(path),
    },
    openGraph: {
      title,
      description,
      url: canonical,
      locale: localeConfig[locale].ogLocale,
      alternateLocale: [localeConfig[locale === "en" ? "zh" : "en"].ogLocale],
      type: "website",
      images: [{ url: shareImage, width: 1200, height: 630, alt: title }],
    },
    twitter: { card: "summary_large_image", title, description, images: [shareImage] },
    robots: { index: true, follow: true },
  };
}
