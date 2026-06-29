import { createServerSupabaseClient } from "@/lib/supabase/server";
import { InquiryForm } from "@/components/public/InquiryForm";
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
  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from("company_profile")
    .select("*")
    .limit(1)
    .single();

  const company = data as CompanyProfile | null;
  const defaultProduct = searchParams.product || "";

  const contacts = [
    company?.phone && {
      icon: Phone,
      label: "电话",
      value: company.phone,
      href: `tel:${company.phone.replace(/[\s-]/g, "")}`,
    },
    company?.email && {
      icon: Mail,
      label: "邮箱",
      value: company.email,
      href: `mailto:${company.email}`,
    },
    company?.whatsapp && {
      icon: MessageCircle,
      label: "WhatsApp",
      value: company.whatsapp,
      href: `https://wa.me/${company.whatsapp.replace(/[^\d]/g, "")}`,
    },
    company?.address_cn && {
      icon: MapPin,
      label: "地址",
      value: company.address_cn,
      href: undefined,
    },
  ].filter(Boolean) as Array<{
    icon: typeof Phone;
    label: string;
    value: string;
    href?: string;
  }>;

  return (
    <div className="animate-fade-in">
      {/* Hero */}
      <section className="bg-hero-gradient relative overflow-hidden px-4 pb-6 pt-10 text-white">
        <div className="bg-grid pointer-events-none absolute inset-0 opacity-40" />
        <div className="relative">
          <h1 className="text-xl font-bold">联系询盘</h1>
          <p className="mt-1 text-xs text-gray-400">
            国内工程 · 海外采购 · 规格定制
          </p>
        </div>
      </section>

      {/* 联系方式 */}
      {contacts.length > 0 && (
        <section className="bg-white px-4 py-5">
          <h2 className="text-sm font-semibold text-graphite">联系方式</h2>
          <div className="mt-3 space-y-2.5">
            {contacts.map((c, i) => {
              const Icon = c.icon;
              const content = (
                <div className="flex items-start gap-3 rounded-xl bg-gray-50 p-3.5 transition hover:bg-gray-100">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-steel/10">
                    <Icon className="h-4 w-4 text-steel" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] text-gray-400">{c.label}</p>
                    <p className="mt-0.5 break-all text-sm text-graphite">
                      {c.value}
                    </p>
                  </div>
                </div>
              );
              return c.href ? (
                <a key={i} href={c.href} target={c.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
                  {content}
                </a>
              ) : (
                <div key={i}>{content}</div>
              );
            })}
          </div>

          {/* 微信二维码 */}
          {company?.wechat_qr_url && (
            <div className="mt-4 flex flex-col items-center rounded-xl bg-gray-50 p-4">
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <QrCode className="h-4 w-4" /> 微信扫码咨询
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={company.wechat_qr_url}
                alt="微信二维码"
                className="mt-3 h-32 w-32 rounded-lg object-cover"
                loading="lazy"
              />
            </div>
          )}
        </section>
      )}

      {/* 询盘表单 */}
      <section className="mt-2 bg-white px-4 py-5">
        <h2 className="text-sm font-semibold text-graphite">在线询盘</h2>
        <p className="mt-0.5 text-xs text-gray-400">
          填写下方表单，我们会在 1 个工作日内回复您。
        </p>
        <div className="mt-4">
          <InquiryForm defaultProduct={defaultProduct} />
        </div>
      </section>
    </div>
  );
}
