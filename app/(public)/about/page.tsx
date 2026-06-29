import { createServerSupabaseClient } from "@/lib/supabase/server";
import { siteUrl } from "@/lib/utils";
import type { Metadata } from "next";
import type { CompanyProfile } from "@/types/database";
import {
  Boxes,
  ShieldCheck,
  Factory,
  Globe2,
  CheckCircle2,
} from "lucide-react";

export const metadata: Metadata = {
  title: "公司介绍",
  description:
    "KZQ 公司介绍：产品能力、品控能力、生产与交付能力、面向国内与海外客户的服务能力。",
};

export const revalidate = 60;

export default async function AboutPage() {
  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from("company_profile")
    .select("*")
    .limit(1)
    .single();

  const company = data as CompanyProfile | null;

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
    <div className="animate-fade-in">
      {/* Hero */}
      <section className="bg-hero-gradient relative overflow-hidden px-4 pb-8 pt-10 text-white">
        <div className="bg-grid pointer-events-none absolute inset-0 opacity-40" />
        <div className="relative">
          <h1 className="text-2xl font-bold">
            {company?.title_cn || "KZQ · 工程级板材品牌"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-gray-300">
            {company?.description_cn ||
              "KZQ 专注于工程级板材与装饰饰面板，服务国内工程精装与海外采购，欢迎通过询盘表单联系。"}
          </p>
        </div>
      </section>

      {/* 品牌介绍 */}
      <section className="bg-white px-4 py-6">
        <h2 className="text-base font-semibold text-graphite">品牌介绍</h2>
        <p className="mt-2 text-sm leading-relaxed text-gray-600">
          {company?.description_cn ||
            "KZQ 是一家专注于工程级板材的品牌供应商，核心产品涵盖饰面板、防火板等多个品类，具体产品规格与等级以产品中心展示为准，欢迎国内外客户通过询盘表单联系合作。"}
        </p>
        {company?.description_en && (
          <p className="mt-3 text-xs leading-relaxed text-gray-400">
            {company.description_en}
          </p>
        )}
      </section>

      {/* 能力介绍 */}
      <section className="mt-2 bg-white px-4 py-6">
        <h2 className="text-base font-semibold text-graphite">核心能力</h2>
        <div className="mt-3 space-y-3">
          {capabilities.map((cap, i) => {
            const Icon = cap.icon;
            return (
              <div
                key={i}
                className="flex gap-3 rounded-xl bg-gray-50 p-4"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-steel/10">
                  <Icon className="h-5 w-5 text-steel" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-graphite">
                    {cap.title}
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500">
                    {cap.desc}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 优势列表（来自 company_profile） */}
      {company?.advantages_cn && company.advantages_cn.length > 0 && (
        <section className="mt-2 bg-white px-4 py-6">
          <h2 className="text-base font-semibold text-graphite">品牌优势</h2>
          <div className="mt-3 space-y-2.5">
            {company.advantages_cn.map((adv, i) => (
              <div key={i} className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                <div>
                  <p className="text-sm font-medium text-graphite">
                    {adv.title_cn}
                  </p>
                  <p className="text-xs text-gray-500">{adv.desc_cn}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </div>
  );
}
