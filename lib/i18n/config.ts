export const locales = ["zh", "en"] as const;

export type Locale = (typeof locales)[number];

export const DEFAULT_LOCALE: Locale = "zh";

export const localeConfig: Record<
  Locale,
  { htmlLang: string; ogLocale: string; prefix: string; dateLocale: string }
> = {
  zh: {
    htmlLang: "zh-CN",
    ogLocale: "zh-CN",
    prefix: "",
    dateLocale: "zh-CN",
  },
  en: {
    htmlLang: "en",
    ogLocale: "en",
    prefix: "/en",
    dateLocale: "en",
  },
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && locales.includes(value as Locale);
}

export function localePath(locale: Locale, path = "/"): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (locale === DEFAULT_LOCALE) return normalized;
  if (normalized === "/") return localeConfig[locale].prefix;
  return `${localeConfig[locale].prefix}${normalized}`;
}

export function localeFromPathname(pathname: string): Locale {
  return pathname === "/en" || pathname.startsWith("/en/") ? "en" : "zh";
}

export function pathWithoutLocale(pathname: string): string {
  if (pathname === "/en") return "/";
  if (pathname.startsWith("/en/")) return pathname.slice(3) || "/";
  return pathname || "/";
}

export function switchLocalePath(pathname: string, target: Locale): string {
  return localePath(target, pathWithoutLocale(pathname));
}

export function alternateLocale(locale: Locale): Locale {
  return locale === "en" ? "zh" : "en";
}

export function formatLocaleDate(
  value: string | Date,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat(localeConfig[locale].dateLocale, options).format(
    typeof value === "string" ? new Date(value) : value
  );
}

export function formatLocaleNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(localeConfig[locale].dateLocale).format(value);
}
