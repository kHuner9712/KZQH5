import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { mockCertificates } from "@/lib/mock-data";
import { CertificateCard } from "@/components/public/CertificateCard";
import { EmptyState } from "@/components/public/EmptyState";
import { Award, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import type { Certificate } from "@/types/database";

export const metadata: Metadata = {
  title: "资质证书",
  description:
    "KZQ 资质证书：E0 级环保检测、B 级防火检测、工厂品控能力评估等，第三方检测认证保障。",
};

export const revalidate = 60;

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

  return (
    <div className="animate-fade-in bg-canvas">
      {/* Hero（轻量暖白） */}
      <div className="bg-canvas-warm px-5 pb-5 pt-10 texture-paper">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brass/10 ring-1 ring-inset ring-brass/20">
          <Award className="h-5 w-5 text-brass" />
        </div>
        <p className="mt-3 text-[10px] uppercase tracking-[0.2em] text-brass">
          Certificates
        </p>
        <h1 className="mt-1 text-xl font-bold tracking-tight text-ink">
          资质证书
        </h1>
        <p className="mt-1 text-[12px] text-ink-soft">
          第三方检测认证 · 工程级品质保障
        </p>
        <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-ink-line bg-white px-3 py-1 text-[11px] text-ink-soft">
          <ShieldCheck className="h-3 w-3 text-emerald-600" />
          仅展示水印版/展示版，完整资料请联系销售
        </div>
      </div>

      {/* 证书统计条 */}
      {certificates.length > 0 && (
        <div className="px-5 pt-5">
          <div className="card-base flex items-center justify-between p-4">
            <div>
              <p className="text-2xl font-bold text-ink">
                {certificates.length}
              </p>
              <p className="text-[11px] text-ink-mute">已发布证书</p>
            </div>
            <div className="h-8 w-px bg-ink-line" />
            <div className="text-right">
              <p className="text-[13px] font-semibold text-industrial">
                环保 / 防火 / 品控
              </p>
              <p className="text-[11px] text-ink-mute">三大认证方向</p>
            </div>
          </div>
        </div>
      )}

      {/* 证书网格 */}
      <div className="px-5 py-5">
        {certificates.length > 0 ? (
          <div className="grid grid-cols-2 gap-2.5">
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
      </div>
    </div>
  );
}
