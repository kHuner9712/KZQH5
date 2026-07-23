import { QrCode } from "lucide-react";
import type { Metadata } from "next";
import { ContactCard } from "@/components/public/ContactCard";
import { ContactQuickActions } from "@/components/public/ContactQuickActions";
import { InquiryForm } from "@/components/public/InquiryForm";
import { QRCodeImage } from "@/components/public/QRCodeImage";
import { ResponsiveContainer } from "@/components/public/ResponsiveContainer";
import { SectionHeader } from "@/components/public/SectionHeader";
import { isDemoMode } from "@/lib/demo";
import { localizeCompany, localizePage } from "@/lib/i18n/content";
import type { Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";
import { mockCompany } from "@/lib/mock-data";
import { placeholderContactNotice, safeAddress, safeEmail, safePhone, safeWhatsApp, sanitizeCompany } from "@/lib/content/placeholder-detection";
import { fetchPageContent } from "@/lib/queries/cms";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import type { CompanyProfile } from "@/types/database";

export const publicContactRevalidate = 300;
export async function getContactMetadata(locale: Locale): Promise<Metadata> { const content = localizePage(await fetchPageContent("contact"), locale); const copy = getDictionary(locale).contact; return buildLocalizedMetadata({ locale, path: "/contact", title: content.seoTitle || content.title || copy.title, description: content.seoDescription || content.description || copy.subtitle }); }
export function generateMetadata() { return getContactMetadata("zh"); }

interface ContactSearchParams {
  product?: string;
  product_id?: string;
  product_slug?: string;
  page_url?: string;
}

export async function ContactPageContent(locale: Locale, searchParams: ContactSearchParams) {
  let company: CompanyProfile | null = null;
  if (isDemoMode()) company = mockCompany;
  else { const { data, error } = await createPublicSupabaseClient().from("company_profile").select("*").limit(1).maybeSingle(); if (error) throw new Error("PUBLIC_DATA_UNAVAILABLE", { cause: error }); company = sanitizeCompany((data as CompanyProfile | null) || null); }
  const content = localizePage(await fetchPageContent("contact"), locale);
  const localizedCompany = localizeCompany(company, locale);
  const copy = getDictionary(locale).contact;
  const methods = content.sections[0]; const formSection = content.sections[1];
  const phone = safePhone(company?.phone);
  const email = safeEmail(company?.email);
  const whatsapp = safeWhatsApp(company?.whatsapp);
  const address = safeAddress(localizedCompany.address);
  const wechatQrUrl = company?.wechat_qr_url || null;
  const hasAnyContact = Boolean(phone || email || whatsapp || address);
  return (
    <div className="animate-fade-in bg-canvas">
      <section className="bg-canvas-warm texture-paper"><ResponsiveContainer className="pb-6 pt-10 md:pb-10 md:pt-16"><p className="text-[10px] uppercase tracking-[0.2em] text-brass md:text-xs">Contact Us</p><h1 className="mt-1.5 text-xl font-bold tracking-tight text-ink md:mt-2 md:text-3xl">{content.title || copy.title}</h1><p className="mt-1 text-[12px] text-ink-soft md:mt-2 md:text-sm">{content.subtitle || copy.subtitle}</p>{content.description && <p className="mt-2 max-w-2xl text-[11.5px] leading-relaxed text-ink-mute md:text-xs">{content.description}</p>}</ResponsiveContainer></section>
      <ResponsiveContainer className="py-8 md:py-12"><div className="md:grid md:grid-cols-5 md:gap-10 lg:gap-14"><div className="md:col-span-2"><SectionHeader title={methods?.title || copy.methods} size="large" /><div className="mt-4 space-y-2.5 md:mt-6 md:space-y-3">{phone && <ContactCard icon="phone" label={copy.phone} value={phone} href={`tel:${phone.replace(/[^+\d]/g, "")}`} />}{email && <ContactCard icon="email" label={copy.email} value={email} href={`mailto:${email}`} />}{whatsapp && <ContactCard icon="whatsapp" label="WhatsApp" value={whatsapp} href={`https://wa.me/${whatsapp.replace(/[^\d]/g, "")}`} external />}{address && <ContactCard icon="address" label={copy.address} value={address} />}{!hasAnyContact && <p className="rounded-xl border border-ink-line bg-canvas-warm px-4 py-3 text-[12px] leading-5 text-ink-mute">{placeholderContactNotice[locale]}</p>}</div><ContactQuickActions phone={phone} wechat={company?.wechat} locale={locale} />{wechatQrUrl && <div className="mt-4 flex flex-col items-center rounded-2xl border border-ink-line bg-canvas-warm p-4 md:mt-6"><div className="flex items-center gap-1.5 text-[11px] text-ink-soft"><QrCode className="h-4 w-4 text-industrial" />{copy.wechat}</div><div className="mt-3 overflow-hidden rounded-lg bg-white p-1.5"><QRCodeImage src={wechatQrUrl} className="h-32 w-32 md:h-36 md:w-36" /></div><p className="mt-2 text-[11px] text-ink-mute">{copy.wechatSales}</p></div>}</div><div className="mt-8 md:col-span-3 md:mt-0"><SectionHeader title={formSection?.title || copy.form} subtitle={formSection?.subtitle || formSection?.body || copy.formSubtitle} size="large" /><div className="mt-4 md:mt-6"><InquiryForm defaultProduct={searchParams.product || ""} productContext={{ id: searchParams.product_id, slug: searchParams.product_slug, name: searchParams.product, pageUrl: searchParams.page_url }} locale={locale} /></div></div></div></ResponsiveContainer>
    </div>
  );
}
export default function ContactPage({ searchParams }: { searchParams: ContactSearchParams }) { return ContactPageContent("zh", searchParams); }
