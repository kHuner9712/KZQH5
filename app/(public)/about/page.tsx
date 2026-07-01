import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { mockCompany } from "@/lib/mock-data";
import { siteUrl } from "@/lib/utils";
import { SectionHeader } from "@/components/public/SectionHeader";
import type { Metadata } from "next";
import type { CompanyProfile } from "@/types/database";
import {
  Boxes,
  ShieldCheck,
  Factory,
  Globe2,
  ArrowRight,
  Phone,
} from "lucide-react";

export const metadata: Metadata = {
  title: "公司介绍",
  description:
    "KZQ 公司介绍：产品能力、品控能力、生产与交付能力、面向国内与海外客户的服务能力。",
};

export const revalidate = 60;

export default async function AboutPage() {
  let company: CompanyProfile | null = null;

  if (isDemoMode()) {
    company = mockCompany;
  } else {
    const supabase = createServerSupabaseClient();
    const { data } = await supabase
      .from("company_profile")
      .select("*")
      .limit(1)
      .single();
    company = (data as CompanyProfile | null) || null;
  }

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "KZQ",
    url: siteUrl(),
    logo: company?.logo_url,
    description: company?.description_cn,
    address: company?.address_cn
      ? {
          "@type": "PostalAddress",
          streetAddress: company.address_cn,
        }
      : undefined,
    contactPoint: {
      "@type": "ContactPoint",
      telephone: company?.phone,
      email: company?.email,
      contactType: "sales",
    },
  };

  const capabilities = [
    {
      icon: Boxes,
      title: "产品能力",
      desc: "提供工程级板材与装饰饰面板等多品类产品，规格可定制，详见产品中心。",
    },
    {
      icon: ShieldCheck,
      title: "品控能力",
      desc: "建立完整品控流程，产品按公开的防火与环保等级交付，具体等级以产品详情与资质证书为准。",
    },
    {
      icon: Factory,
      title: "生产与交付能力",
      desc: "稳定产能保障工程批量供货，支持定制规格生产，国内配送与海外出口并行。",
    },
    {
      icon: Globe2,
      title: "国内与海外服务",
      desc: "国内服务工程精装项目；海外支持多语言询盘响应，贸易条款与认证要求可在线咨询。",
    },
  ];

  return (
    <div className="animate-fade-in bg-canvas">
      {/* Hero */}
      <section className="bg-canvas-warm px-5 pb-8 pt-10 texture-paper">
        <p className="text-[10px] uppercase tracking-[0.22em] text-brass">
          About KZQ
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink">
          {company?.title_cn || "KZQ · 工程级板材品牌"}
        </h1>
        <p className="mt-3 max-w-[20rem] text-[13px] leading-relaxed text-ink-soft">
          {company?.description_cn ||
            "KZQ 专注于工程级板材与装饰饰面板，服务国内工程精装与海外采购，欢迎通过询盘表单联系。"}
        </p>
        {company?.address_cn && (
          <p className="mt-3 text-[11px] text-ink-mute">
            {company.address_cn}
          </p>
        )}
      </section>

      {/* 核心能力 */}
      <section className="px-5 pt-7">
        <SectionHeader
          title="核心能力"
          subtitle="产品 · 品控 · 交付 · 海外服务"
        />
        <div className="mt-3 space-y-2.5">
          {capabilities.map((cap, i) => {
            const Icon = cap.icon;
            return (
              <div key={i} className="card-base flex gap-3.5 p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-industrial-50">
                  <Icon className="h-5 w-5 text-industrial" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-[13px] font-semibold text-ink">
                    {cap.title}
                  </h3>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">
                    {cap.desc}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 品牌优势（来自 company_profile） */}
      {company?.advantages_cn && company.advantages_cn.length > 0 && (
        <section className="px-5 pt-7">
          <SectionHeader title="品牌优势" subtitle="KZQ 差异化能力" />
          <div className="mt-3 space-y-2">
            {company.advantages_cn.map((adv, i) => (
              <div
                key={i}
                className="flex items-start gap-3 rounded-xl border border-ink-line bg-canvas-warm p-3"
              >
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-[10px] font-bold text-industrial">
                  {i + 1}
                </div>
                <div>
                  <p className="text-[13px] font-medium text-ink">
                    {adv.title_cn}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-ink-soft">
                    {adv.desc_cn}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 询盘 CTA */}
      <section className="px-5 pt-7 pb-4">
        <Link
          href="/contact"
          className="card-base relative block overflow-hidden bg-industrial p-5 text-white"
        >
          <div
            className="absolute inset-0 opacity-[0.08]"
            style={{
              backgroundImage:
                "repeating-linear-gradient(90deg, rgba(255,255,255,0.6) 0, rgba(255,255,255,0.6) 1px, transparent 1px, transparent 28px)",
            }}
          />
          <div className="relative flex items-center justify-between">
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/60">
                Get Quotation
              </p>
              <h3 className="mt-1 text-base font-semibold">联系 KZQ</h3>
              <p className="mt-0.5 text-[11px] text-white/70">
                国内工程 · 海外采购 · 规格定制
              </p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 backdrop-blur-sm">
              <ArrowRight className="h-5 w-5" />
            </div>
          </div>
        </Link>
        {company?.phone && (
          <a
            href={`tel:${company.phone.replace(/[^+\d]/g, "")}`}
            className="mt-2 flex items-center justify-center gap-1.5 rounded-xl border border-ink-line bg-white py-3 text-[12px] text-ink-soft transition hover:border-industrial/30 hover:text-industrial"
          >
            <Phone className="h-3.5 w-3.5" /> {company.phone}
          </a>
        )}
      </section>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </div>
  );
}
