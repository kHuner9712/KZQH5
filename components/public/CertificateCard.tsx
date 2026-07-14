import { Award, ShieldCheck } from "lucide-react";
import type { Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { localizeCertificate } from "@/lib/i18n/content";
import type { Certificate } from "@/types/database";
import { ProductImage } from "./ProductImage";

export function CertificateCard({ cert, variant = "default", locale = "zh" }: { cert: Certificate; variant?: "default" | "compact"; locale?: Locale }) {
  const compact = variant === "compact";
  const content = localizeCertificate(cert, locale);
  const copy = getDictionary(locale);
  return (
    <div className={compact ? "overflow-hidden rounded-md border border-white/10 bg-white/[0.04]" : "card-base"}>
      <div className={compact ? "relative aspect-[4/3]" : "relative aspect-[3/4]"}><ProductImage src={cert.image_url} alt={content.name} placeholder="cert" fallbackText={<AwardLabel />} sizes={compact ? "(max-width: 768px) 40vw, 220px" : "(max-width: 768px) 50vw, 280px"} /><span className="absolute left-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] font-medium text-white backdrop-blur-sm">{copy.certificates.displayVersion}</span></div>
      <div className="p-3"><h3 className={compact ? "line-clamp-2 text-xs font-medium leading-5 text-white" : "line-clamp-1 text-[13px] font-semibold text-ink"}>{content.name}</h3>{content.secondaryName && <p className={compact ? "mt-1 line-clamp-1 text-[9px] text-white/40" : "mt-0.5 line-clamp-1 text-[10px] text-ink-mute"}>{content.secondaryName}</p>}{!compact && content.description && <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-ink-soft">{content.description}</p>}{!compact && content.applicableScope && <p className="mt-2 inline-flex items-center gap-1 rounded bg-industrial-50 px-1.5 py-0.5 text-[10px] text-industrial"><ShieldCheck className="h-2.5 w-2.5" />{content.applicableScope}</p>}</div>
    </div>
  );
}

function AwardLabel() { return <span className="flex flex-col items-center gap-1.5"><Award className="h-7 w-7 text-brass/50" /><span className="text-[10px] font-semibold tracking-wider text-ink-mute/50">KZQ · CERT</span></span>; }
