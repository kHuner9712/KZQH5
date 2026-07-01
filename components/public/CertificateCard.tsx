import { Award, ShieldCheck } from "lucide-react";
import type { Certificate } from "@/types/database";
import { ProductImage } from "./ProductImage";

interface CertificateCardProps {
  cert: Certificate;
}

/**
 * 证书卡片 - 资质展示风格
 * - 无图片时显示证书样式占位卡（不破图）
 * - 强调"展示版/水印版证书，完整资料请联系销售"
 */
export function CertificateCard({ cert }: CertificateCardProps) {
  return (
    <div className="card-base">
      <div className="relative aspect-[3/4]">
        <ProductImage
          src={cert.image_url}
          alt={cert.name_cn}
          placeholder="cert"
          fallbackText={<AwardLabel />}
        />
        <span className="absolute left-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] font-medium text-white backdrop-blur-sm">
          展示版
        </span>
      </div>
      <div className="p-3">
        <h3 className="line-clamp-1 text-[13px] font-semibold text-ink">
          {cert.name_cn}
        </h3>
        {cert.name_en && (
          <p className="mt-0.5 line-clamp-1 text-[10px] text-ink-mute">
            {cert.name_en}
          </p>
        )}
        {cert.description_cn && (
          <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-ink-soft">
            {cert.description_cn}
          </p>
        )}
        {cert.applicable_scope_cn && (
          <p className="mt-2 inline-flex items-center gap-1 rounded bg-industrial-50 px-1.5 py-0.5 text-[10px] text-industrial">
            <ShieldCheck className="h-2.5 w-2.5" />
            {cert.applicable_scope_cn}
          </p>
        )}
      </div>
    </div>
  );
}

/** 占位时使用的资质卡视觉 */
function AwardLabel() {
  return (
    <span className="flex flex-col items-center gap-1.5">
      <Award className="h-7 w-7 text-brass/50" />
      <span className="text-[10px] font-semibold tracking-wider text-ink-mute/50">
        KZQ · CERT
      </span>
    </span>
  );
}
