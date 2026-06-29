import { createServerSupabaseClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/public/EmptyState";
import { Award, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import type { Certificate } from "@/types/database";

export const metadata: Metadata = {
  title: "资质证书",
  description:
    "KZQ 资质证书：E0 级环保检测、B 级防火检测、ISO 9001 质量管理体系认证等，第三方检测认证保障。",
};

export const revalidate = 60;

export default async function CertificatesPage() {
  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from("certificates")
    .select("*")
    .eq("is_published", true)
    .order("sort_order", { ascending: true });

  const certificates = (data as Certificate[] | null) || [];

  return (
    <div className="animate-fade-in">
      <div className="bg-hero-gradient relative overflow-hidden px-4 pb-6 pt-10 text-white">
        <div className="bg-grid pointer-events-none absolute inset-0 opacity-40" />
        <div className="relative">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gold/20">
            <Award className="h-6 w-6 text-gold" />
          </div>
          <h1 className="mt-3 text-xl font-bold">资质证书</h1>
          <p className="mt-1 text-xs text-gray-400">
            第三方检测认证 · 工程级品质保障
          </p>
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[11px] text-gray-300">
            <ShieldCheck className="h-3 w-3 text-emerald-400" />
            仅展示水印版/展示版，不上传高清源文件
          </div>
        </div>
      </div>

      <div className="px-4 py-4">
        {certificates.length > 0 ? (
          <div className="grid grid-cols-2 gap-3">
            {certificates.map((c) => (
              <CertCard key={c.id} cert={c} />
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

function CertCard({ cert }: { cert: Certificate }) {
  return (
    <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-100">
      <div className="relative aspect-[3/4] bg-gray-100">
        {cert.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cert.image_url}
            alt={cert.name_cn}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-gray-300">
            <Award className="h-10 w-10" />
          </div>
        )}
        <span className="absolute left-2 top-2 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] text-white backdrop-blur-sm">
          展示版
        </span>
      </div>
      <div className="p-3">
        <h3 className="line-clamp-1 text-sm font-semibold text-graphite">
          {cert.name_cn}
        </h3>
        {cert.name_en && (
          <p className="mt-0.5 line-clamp-1 text-[10px] text-gray-400">
            {cert.name_en}
          </p>
        )}
        {cert.description_cn && (
          <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-gray-500">
            {cert.description_cn}
          </p>
        )}
        {cert.applicable_scope_cn && (
          <p className="mt-2 inline-block rounded bg-steel/5 px-1.5 py-0.5 text-[10px] text-steel">
            适用：{cert.applicable_scope_cn}
          </p>
        )}
      </div>
    </div>
  );
}
