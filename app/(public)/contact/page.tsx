import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { mockCompany } from "@/lib/mock-data";
import { InquiryForm } from "@/components/public/InquiryForm";
import { ContactCard } from "@/components/public/ContactCard";
import { SectionHeader } from "@/components/public/SectionHeader";
import type { Metadata } from "next";
import type { CompanyProfile } from "@/types/database";
import { Phone, Mail, MessageCircle, MapPin, QrCode } from "lucide-react";

export const metadata: Metadata = {
  title: "联系询盘",
  description:
    "联系 KZQ 获取产品报价。支持电话、邮箱、WhatsApp、微信咨询，海外客户可直接提交询盘表单。",
};

export default async function ContactPage({
  searchParams,
}: {
  searchParams: { product?: string };
}) {
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

  const defaultProduct = searchParams.product || "";

  return (
    <div className="animate-fade-in bg-canvas">
      {/* Hero */}
      <section className="bg-canvas-warm px-5 pb-6 pt-10 texture-paper">
        <p className="text-[10px] uppercase tracking-[0.2em] text-brass">
          Contact Us
        </p>
        <h1 className="mt-1.5 text-xl font-bold tracking-tight text-ink">
          联系询盘
        </h1>
        <p className="mt-1 text-[12px] text-ink-soft">
          国内工程 · 海外采购 · 规格定制
        </p>
        <p className="mt-2 max-w-[18rem] text-[11.5px] leading-relaxed text-ink-mute">
          提交询盘表单获取专属报价，1 个工作日内回复；紧急需求可直接电话或 WhatsApp 联系。
        </p>
      </section>

      {/* 联系方式 */}
      <section className="px-5 pt-5">
        <SectionHeader title="联系方式" />
        <div className="mt-3 space-y-2.5">
          {company?.phone && (
            <ContactCard
              icon={Phone}
              label="电话"
              value={company.phone}
              href={`tel:${company.phone.replace(/[\s-]/g, "")}`}
            />
          )}
          {company?.email && (
            <ContactCard
              icon={Mail}
              label="邮箱"
              value={company.email}
              href={`mailto:${company.email}`}
            />
          )}
          {company?.whatsapp && (
            <ContactCard
              icon={MessageCircle}
              label="WhatsApp"
              value={company.whatsapp}
              href={`https://wa.me/${company.whatsapp.replace(/[^\d]/g, "")}`}
              external
            />
          )}
          {company?.address_cn && (
            <ContactCard
              icon={MapPin}
              label="地址"
              value={company.address_cn}
            />
          )}
        </div>

        {/* 微信二维码 */}
        {company?.wechat_qr_url && (
          <div className="mt-3 flex flex-col items-center rounded-2xl border border-ink-line bg-canvas-warm p-4">
            <div className="flex items-center gap-1.5 text-[11px] text-ink-soft">
              <QrCode className="h-4 w-4 text-industrial" /> 微信扫码咨询
            </div>
            <div className="mt-3 overflow-hidden rounded-lg bg-white p-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={company.wechat_qr_url}
                alt="微信二维码"
                className="h-32 w-32 rounded object-cover"
                loading="lazy"
                onError={(e) => {
                  const t = e.currentTarget;
                  t.style.display = "none";
                  const p = t.parentElement;
                  if (p) {
                    p.classList.add("flex", "items-center", "justify-center");
                    p.innerHTML =
                      '<div class="h-32 w-32 flex items-center justify-center text-ink-mute text-[10px]">二维码待上传</div>';
                  }
                }}
              />
            </div>
            <p className="mt-2 text-[11px] text-ink-mute">扫码添加 KZQ 销售</p>
          </div>
        )}
      </section>

      {/* 询盘表单 */}
      <section className="px-5 pt-7 pb-4">
        <SectionHeader
          title="在线询盘"
          subtitle="填写下方表单，我们会在 1 个工作日内回复您"
        />
        <div className="mt-4">
          <InquiryForm defaultProduct={defaultProduct} />
        </div>
      </section>
    </div>
  );
}
