import Link from "next/link";
import { BookOpen, Building2, FileText, FolderKanban, Languages, Mail, ShieldCheck } from "lucide-react";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ResponsiveContainer } from "./ResponsiveContainer";
import { localePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";
import { getPublicSiteShellData } from "@/lib/services/public-site";
import type { Metadata } from "next";

export function getMoreMetadata(locale: Locale): Metadata { const title = getDictionary(locale).more.title; return buildLocalizedMetadata({ locale, path: "/more", title, description: title }); }
export function getPrivacyMetadata(locale: Locale): Metadata { const copy = getDictionary(locale).privacy; return buildLocalizedMetadata({ locale, path: "/privacy", title: copy.title, description: copy.intro }); }

export function MorePageContent({ locale }: { locale: Locale }) {
  const copy = getDictionary(locale);
  const links = [
    { href: "/documents", label: locale === "zh" ? "产品目录与色卡" : "Catalogs & Color Cards", icon: BookOpen },
    { href: "/projects", label: copy.more.projects, icon: FolderKanban },
    { href: "/certificates", label: copy.more.certificates, icon: ShieldCheck },
    { href: "/about", label: copy.more.about, icon: Building2 },
    { href: "/contact", label: copy.more.contact, icon: Mail },
    { href: "/privacy", label: copy.more.privacy, icon: FileText },
  ];
  return <ResponsiveContainer className="py-8 md:py-14"><h1 className="text-2xl font-semibold text-ink md:text-4xl">{copy.more.title}</h1><div className="mt-6 grid gap-3 sm:grid-cols-2">{links.map((item) => { const Icon = item.icon; return <Link key={item.href} href={localePath(locale, item.href)} className="card-base flex min-h-14 items-center gap-3 p-4 text-sm font-medium text-ink transition hover:border-gold/40"><Icon className="h-5 w-5 text-brass" />{item.label}</Link>; })}<div className="card-base flex min-h-14 items-center justify-between gap-3 p-4"><span className="flex items-center gap-3 text-sm font-medium text-ink"><Languages className="h-5 w-5 text-brass" />{copy.common.language}</span><LanguageSwitcher locale={locale} className="text-industrial" /></div></div></ResponsiveContainer>;
}

export async function PrivacyPageContent({ locale }: { locale: Locale }) {
  const copy = getDictionary(locale).privacy;
  const { company } = await getPublicSiteShellData();
  const sections = [[copy.collectionTitle, copy.collectionBody], [copy.useTitle, copy.useBody], [copy.retentionTitle, copy.retentionBody], [copy.saleTitle, copy.saleBody], [copy.securityTitle, copy.securityBody], [copy.contactTitle, copy.contactBody]];
  return <ResponsiveContainer className="py-8 md:py-14"><article className="mx-auto max-w-3xl"><p className="text-[10px] uppercase tracking-[0.2em] text-brass">KZQ</p><h1 className="mt-2 text-2xl font-semibold text-ink md:text-4xl">{copy.title}</h1><p className="mt-4 text-sm leading-7 text-ink-soft">{copy.intro}</p><div className="mt-8 space-y-7">{sections.map(([title, body]) => <section key={title}><h2 className="text-lg font-semibold text-ink">{title}</h2><p className="mt-2 text-sm leading-7 text-ink-soft">{body}</p>{title === copy.contactTitle && <div className="mt-3 flex flex-wrap gap-3 text-sm">{company?.email && <a href={`mailto:${company.email}`} className="text-industrial underline">{company.email}</a>}{company?.phone && <a href={`tel:${company.phone.replace(/[^+\d]/g, "")}`} className="text-industrial underline">{company.phone}</a>}<Link href={localePath(locale, "/contact")} className="text-industrial underline">{getDictionary(locale).more.contact}</Link></div>}</section>)}</div></article></ResponsiveContainer>;
}

export function NotFoundContent({ locale }: { locale: Locale }) {
  const copy = getDictionary(locale).errors;
  return <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center"><p className="text-gradient-gold text-7xl font-bold">404</p><h1 className="mt-4 text-xl font-semibold text-ink">{copy.notFound}</h1><p className="mt-2 text-sm text-ink-mute">{copy.notFoundDescription}</p><div className="mt-8 flex flex-wrap justify-center gap-3"><Link href={localePath(locale)} className="btn-primary h-11 px-6">{copy.backHome}</Link><Link href={localePath(locale, "/products")} className="btn-outline h-11 px-6">{locale === "zh" ? "产品中心" : "Products"}</Link></div></div>;
}
