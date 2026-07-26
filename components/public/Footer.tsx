import Link from "next/link";
import { Mail, MapPin, Phone } from "lucide-react";
import { localePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import {
  localizeCompany,
  localizeNavItem,
  localizeSiteSettings,
  navigationWithProjects,
} from "@/lib/i18n/content";
import {
  placeholderContactNotice,
  safeAddress,
  safeEmail,
  safePhone,
} from "@/lib/content/placeholder-detection";
import type { CompanyProfile, NavItem, SiteSettings } from "@/types/database";

const fallbackNav: NavItem[] = [
  { href: "/products", label_cn: "产品中心", label_en: "Products" },
  { href: "/projects", label_cn: "应用案例", label_en: "Projects" },
  { href: "/certificates", label_cn: "资质证书", label_en: "Certificates" },
  { href: "/about", label_cn: "关于我们", label_en: "About" },
  { href: "/contact", label_cn: "联系询盘", label_en: "Contact" },
];

interface FooterProps {
  company?: CompanyProfile | null;
  siteSettings?: SiteSettings | null;
  locale: Locale;
}

export function Footer({ company, siteSettings, locale }: FooterProps) {
  const copy = getDictionary(locale);
  const localizedCompany = localizeCompany(company, locale);
  const settings = localizeSiteSettings(siteSettings, locale);
  const navItems = navigationWithProjects(
    siteSettings?.navigation_json?.length
      ? siteSettings.navigation_json
      : fallbackNav,
  );
  const primaryNav = navItems.slice(0, 3);
  const secondaryNav = navItems.slice(3);
  const phone = safePhone(company?.phone);
  const email = safeEmail(company?.email);
  const address = safeAddress(localizedCompany.address);

  return (
    <footer className="border-t border-white/10 bg-page pb-[calc(56px+env(safe-area-inset-bottom))] text-white md:pb-0">
      <div className="px-4 py-8 md:px-12 md:py-16">
        <div className="mx-auto grid max-w-content gap-8 md:grid-cols-[40%_20%_20%_20%] md:gap-0">
          <div className="md:pr-12">
            <div className="flex items-baseline gap-2">
              <span className="font-display text-lg font-semibold tracking-[0.06em] text-gold md:text-2xl">
                KZQ
              </span>
              <span className="text-[10px] text-white/60 md:text-xs">
                {copy.header.tagline}
              </span>
            </div>
            <p className="mt-3 max-w-sm text-[11px] leading-5 text-white/60 md:mt-4 md:text-[13px] md:leading-6">
              {localizedCompany.description ||
                localizedCompany.title ||
                settings.siteName}
            </p>
            <div className="mt-4 space-y-1.5 text-[11px] leading-5 text-white/55 md:mt-5 md:text-[13px]">
              {!phone && !email && !address && (
                <p className="text-white/60">
                  {placeholderContactNotice[locale]}
                </p>
              )}
              {phone && (
                <p className="flex items-start gap-2">
                  <Phone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold" />
                  {phone}
                </p>
              )}
              {email && (
                <p className="flex items-start gap-2">
                  <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold" />
                  {email}
                </p>
              )}
              {address && (
                <p className="flex items-start gap-2">
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold" />
                  {address}
                </p>
              )}
            </div>
          </div>

          <FooterColumn
            title={copy.footer.navigation}
            items={primaryNav}
            locale={locale}
          />
          <FooterColumn
            title={locale === "zh" ? "关于 KZQ" : "About KZQ"}
            items={secondaryNav}
            locale={locale}
          />
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-white">
              {copy.footer.contact}
            </p>
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-3 md:flex-col">
              <Link
                href={localePath(locale, "/contact")}
                className="text-[11px] text-white/60 transition-colors hover:text-gold md:text-[13px]"
              >
                {copy.nav.inquiry}
              </Link>
              <Link
                href={localePath(locale, "/privacy")}
                className="text-[11px] text-white/60 transition-colors hover:text-gold md:text-[13px]"
              >
                {copy.footer.privacy}
              </Link>
            </div>
          </div>
        </div>

        <div className="mx-auto mt-5 max-w-content border-t border-white/[0.08] pt-3 text-[10px] leading-5 text-white/50 md:mt-8 md:pt-8 md:text-xs">
          {settings.footerText || copy.footer.fallback}
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  items,
  locale,
}: {
  title: string;
  items: NavItem[];
  locale: Locale;
}) {
  return (
    <div className="hidden md:block">
      <p className="text-xs font-medium uppercase tracking-[0.08em] text-white">
        {title}
      </p>
      <nav className="mt-4 flex flex-col gap-3" aria-label={title}>
        {items.map((item) => (
          <Link
            key={item.href}
            href={localePath(locale, item.href)}
            className="text-[13px] text-white/60 transition-colors hover:text-gold"
          >
            {localizeNavItem(item, locale)}
          </Link>
        ))}
      </nav>
    </div>
  );
}
