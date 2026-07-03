import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { mockCertificates } from "@/lib/mock-data";
import { fetchPageContent } from "@/lib/queries/cms";
import { CertificateCard } from "@/components/public/CertificateCard";
import { EmptyState } from "@/components/public/EmptyState";
import { ResponsiveContainer } from "@/components/public/ResponsiveContainer";
import { Award, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import type { Certificate } from "@/types/database";

export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  const page = await fetchPageContent("certificates");
  return {
    title: page?.seo_title_cn ?? "资质证书",
    description:
      page?.seo_description_cn ??
      "KZQ 资质证书：已确认可公开展示的环保、防火及相关产品资料，完整证书请联系销售。",
  };
}

export default async function CertificatesPage() {
  let certificates: Certificate[] = [];

  if (isDemoMode()) {
    certificates = [...mockCertificates].sort(
      (a, b) => a.sort_order - b.sort_order
    );
  } else {
    const supabase = createServerSupabaseClient();
    const { data } = await supabase
      .from("certificates")
      .select("*")
      .eq("is_published", true)
      .order("sort_order", { ascending: true });
    certificates = (data as Certificate[] | null) || [];
  }

  // CMS 页面内容（Demo 模式自动回退到 mock 数据）
  const page = await fetchPageContent("certificates");

  return (
    <div className="animate-fade-in bg-canvas">
      {/* Hero */}
      <div className="bg-canvas-warm texture-paper">
        <ResponsiveContainer className="pb-5 pt-10 md:pb-8 md:pt-16">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brass/10 ring-1 ring-inset ring-brass/20 md:h-14 md:w-14">
            <Award className="h-5 w-5 text-brass md:h-6 md:w-6" />
          </div>
          <p className="mt-3 text-[10px] uppercase tracking-[0.2em] text-brass md:text-xs">
            Certificates
          </p>
          <h1 className="mt-1 text-xl font-bold tracking-tight text-ink md:mt-2 md:text-3xl">
            {page?.title_cn ?? "资质证书"}
          </h1>
          <p className="mt-1 text-[12px] text-ink-soft md:mt-2 md:text-sm">
            {page?.subtitle_cn ?? "第三方检测认证 · 工程级品质保障"}
          </p>
          {page?.description_cn ? (
            <p className="mt-2 max-w-2xl text-[11.5px] leading-relaxed text-ink-mute md:text-xs md:leading-relaxed">
              {page.description_cn}
            </p>
          ) : (
            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-ink-line bg-white px-3 py-1 text-[11px] text-ink-soft md:text-xs">
              <ShieldCheck className="h-3 w-3 text-emerald-600" />
              仅展示水印版/展示版，完整资料请联系销售
            </div>
          )}
        </ResponsiveContainer>
      </div>

      {/* 证书统计条 */}
      {certificates.length > 0 && (
        <ResponsiveContainer className="pt-5">
          <div className="card-base flex items-center justify-between p-4 md:p-5">
            <div>
              <p className="text-2xl font-bold text-ink md:text-3xl">
                {certificates.length}
              </p>
              <p className="text-[11px] text-ink-mute md:text-xs">已发布证书</p>
            </div>
            <div className="h-8 w-px bg-ink-line md:h-10" />
            <div className="text-right">
              <p className="text-[13px] font-semibold text-industrial md:text-base">
                环保 / 防火 / 产品资料
              </p>
              <p className="text-[11px] text-ink-mute md:text-xs">完整资料请联系销售</p>
            </div>
          </div>
        </ResponsiveContainer>
      )}

      {/* 证书网格：mobile 2 / tablet 3 / desktop 4 */}
      <ResponsiveContainer className="py-5 md:py-8">
        {certificates.length > 0 ? (
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 md:gap-4 lg:grid-cols-4">
            {certificates.map((c) => (
              <CertificateCard key={c.id} cert={c} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="暂无证书"
            description="请在后台上传并发布证书"
            icon={Award}
          />
        )}
      </ResponsiveContainer>
    </div>
  );
}
