import Link from "next/link";
import { Mail, MapPin, Phone } from "lucide-react";
import { localePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { localizeCompany, localizeNavItem, localizeSiteSettings, navigationWithProjects } from "@/lib/i18n/content";
import { placeholderContactNotice, safeAddress, safeEmail, safePhone } from "@/lib/content/placeholder-detection";
import type { CompanyProfile, NavItem, SiteSettings } from "@/types/database";

const fallbackNav: NavItem[] = [
  { href: "/products", label_cn: "产品中心", label_en: "Products" },
  { href: "/projects", label_cn: "应用案例", label_en: "Projects" },
  { href: "/certificates", label_cn: "资质证书", label_en: "Certificates" },
  { href: "/about", label_cn: "关于我们", label_en: "About" },
  { href: "/contact", label_cn: "联系询盘", label_en: "Contact" },
];

export function Footer({ company, siteSettings, locale }: { company?: CompanyProfile | null; siteSettings?: SiteSettings | null; locale: Locale }) {
  const copy = getDictionary(locale);
  const localizedCompany = localizeCompany(company, locale);
  const settings = localizeSiteSettings(siteSettings, locale);
  const navItems = navigationWithProjects(siteSettings?.navigation_json?.length
    ? siteSettings.navigation_json
    : fallbackNav);

  return (
    <footer className="border-t border-white/10 bg-page pb-[calc(5rem+env(safe-area-inset-bottom))] text-white md:pb-0">
      <div className="container-responsive grid gap-8 py-10 md:grid-cols-[1.2fr_0.8fr_1fr] md:gap-12 md:py-14">
        <div>
          <p className="font-display text-3xl tracking-[0.08em] text-gold-light">KZQ</p>
          <p className="mt-3 max-w-md text-sm leading-6 text-white/[0.55]">{localizedCompany.description || localizedCompany.title || settings.siteName}</p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/40">{copy.footer.navigation}</p>
          <nav className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 md:grid-cols-1" aria-label={copy.footer.navigation}>
            {navItems.map((item) => <Link key={item.href} href={localePath(locale, item.href)} className="text-sm text-white/[0.65] transition hover:text-gold-light">{localizeNavItem(item, locale)}</Link>)}
            <Link href={localePath(locale, "/privacy")} className="text-sm text-white/[0.65] transition hover:text-gold-light">{copy.footer.privacy}</Link>
          </nav>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/40">{copy.footer.contact}</p>
          <div className="mt-4 space-y-3 text-sm text-white/60">
            {(() => {
              const phone = safePhone(company?.phone);
              const email = safeEmail(company?.email);
              const address = safeAddress(localizedCompany.address);
              if (!phone && !email && !address) {
                return <p className="text-xs leading-5 text-white/[0.45]">{placeholderContactNotice[locale]}</p>;
              }
              return (
                <>
                  {phone && <p className="flex items-start gap-2.5"><Phone className="mt-0.5 h-4 w-4 shrink-0 text-gold" />{phone}</p>}
                  {email && <p className="flex items-start gap-2.5"><Mail className="mt-0.5 h-4 w-4 shrink-0 text-gold" />{email}</p>}
                  {address && <p className="flex items-start gap-2.5"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gold" />{address}</p>}
                </>
              );
            })()}
          </div>
        </div>
      </div>
      <div className="border-t border-white/10"><div className="container-responsive py-4 text-[10px] leading-5 text-white/[0.35] md:text-xs">{settings.footerText || copy.footer.fallback}</div></div>
    </footer>
  );
}
