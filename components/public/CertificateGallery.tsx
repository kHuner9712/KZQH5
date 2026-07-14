"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Award, ChevronLeft, ChevronRight, Minus, Plus, ShieldCheck, X } from "lucide-react";
import { localizeCertificate } from "@/lib/i18n/content";
import { getDictionary } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/config";
import type { Certificate } from "@/types/database";
import { ProductImage } from "./ProductImage";
import { trackAnalyticsEvent } from "@/lib/client/analytics";
import { useDialogFocusTrap } from "@/lib/client/use-dialog-focus-trap";

export function CertificateGallery({ certificates, locale, compact = false }: { certificates: Certificate[]; locale: Locale; compact?: boolean }) {
  const copy = getDictionary(locale).certificates;
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const resetTransform = () => { setScale(1); setPosition({ x: 0, y: 0 }); pointers.current.clear(); pinch.current = null; };
  const show = (index: number) => { setActiveIndex((index + certificates.length) % certificates.length); resetTransform(); trackAnalyticsEvent({ event_name: "certificate_view", locale }); };
  const close = () => { setActiveIndex(null); resetTransform(); };
  useDialogFocusTrap({ active: activeIndex !== null, containerRef: dialogRef, onClose: close });

  useEffect(() => {
    if (activeIndex === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") show(activeIndex - 1);
      if (event.key === "ArrowRight") show(activeIndex + 1);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = ""; window.removeEventListener("keydown", onKeyDown); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, certificates.length]);

  function pointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    lastPointer.current = { x: event.clientX, y: event.clientY };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale };
    }
  }

  function pointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      setScale(Math.min(5, Math.max(1, pinch.current.scale * distance / Math.max(1, pinch.current.distance))));
      return;
    }
    if (scale > 1 && lastPointer.current) {
      const dx = event.clientX - lastPointer.current.x;
      const dy = event.clientY - lastPointer.current.y;
      setPosition((current) => ({ x: current.x + dx, y: current.y + dy }));
      lastPointer.current = { x: event.clientX, y: event.clientY };
    }
  }

  function pointerUp(event: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    pinch.current = null;
    const remaining = [...pointers.current.values()][0];
    lastPointer.current = remaining || null;
  }

  const active = activeIndex === null ? null : certificates[activeIndex];
  const activeContent = active ? localizeCertificate(active, locale) : null;

  return (
    <>
      <div className={compact ? "grid grid-cols-2 gap-3 md:grid-cols-4" : "grid grid-cols-2 gap-2.5 md:grid-cols-3 md:gap-4 lg:grid-cols-4"}>
        {certificates.map((certificate, index) => {
          const content = localizeCertificate(certificate, locale);
          return (
            <button key={certificate.id} type="button" onClick={() => show(index)} className={compact ? "overflow-hidden rounded-md border border-white/10 bg-white/[0.04] text-left" : "card-base overflow-hidden text-left transition hover:border-gold/50"} aria-label={`${locale === "zh" ? "全屏查看" : "View full screen"}: ${content.name}`}>
              <div className={compact ? "relative aspect-[4/3]" : "relative aspect-[3/4]"}><ProductImage src={certificate.image_url} alt={content.name} placeholder="cert" fallbackText={<Award className="h-8 w-8 text-brass/50" />} sizes="(max-width: 768px) 50vw, 280px" /><span className="absolute left-2 top-2 rounded bg-black/60 px-2 py-1 text-[9px] text-white">{copy.displayVersion}</span></div>
              <div className="p-3"><h3 className={compact ? "line-clamp-2 text-xs font-medium text-white" : "line-clamp-2 text-sm font-semibold text-ink"}>{content.name}</h3>{content.applicableScope && <p className={compact ? "mt-2 line-clamp-1 text-[10px] text-white/50" : "mt-2 flex items-center gap-1 text-[10px] text-ink-mute"}><ShieldCheck className="h-3 w-3 shrink-0" />{content.applicableScope}</p>}</div>
            </button>
          );
        })}
      </div>

      {active && activeContent && (
        <div ref={dialogRef} tabIndex={-1} className="fixed inset-0 z-[90] flex flex-col bg-black/95" role="dialog" aria-modal="true" aria-label={activeContent.name}>
          <div className="safe-top flex min-h-16 items-center gap-3 border-b border-white/10 px-3 text-white md:px-6"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{activeContent.name}</p><p className="mt-0.5 text-[10px] text-white/50">{activeIndex! + 1} / {certificates.length} · {copy.fullDocs}</p></div><button type="button" onClick={close} className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10" aria-label={locale === "zh" ? "关闭" : "Close"}><X className="h-5 w-5" /></button></div>
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <div className="absolute inset-0 touch-none select-none" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onWheel={(event) => { event.preventDefault(); setScale((current) => Math.min(5, Math.max(1, current + (event.deltaY < 0 ? 0.25 : -0.25)))); }}>
              {active.image_url ? <div className="flex h-full w-full items-center justify-center p-6 md:p-12"><Image src={active.image_url} alt={activeContent.name} width={1200} height={1600} sizes="(max-width: 768px) 100vw, 80vw" draggable={false} className="max-h-full w-auto max-w-full object-contain transition-transform duration-75" style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${scale})` }} /></div> : <div className="flex h-full items-center justify-center text-white/40"><Award className="h-16 w-16" /></div>}
            </div>
            {certificates.length > 1 && <><button type="button" onClick={() => show(activeIndex! - 1)} className="absolute left-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white" aria-label={locale === "zh" ? "上一张" : "Previous"}><ChevronLeft className="h-6 w-6" /></button><button type="button" onClick={() => show(activeIndex! + 1)} className="absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white" aria-label={locale === "zh" ? "下一张" : "Next"}><ChevronRight className="h-6 w-6" /></button></>}
            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-2"><button type="button" onClick={() => setScale((current) => Math.max(1, current - 0.5))} className="flex h-10 w-10 items-center justify-center rounded-full bg-black/65 text-white" aria-label={locale === "zh" ? "缩小" : "Zoom out"}><Minus className="h-4 w-4" /></button><button type="button" onClick={resetTransform} className="min-w-16 rounded-full bg-black/65 px-3 text-xs text-white">{Math.round(scale * 100)}%</button><button type="button" onClick={() => setScale((current) => Math.min(5, current + 0.5))} className="flex h-10 w-10 items-center justify-center rounded-full bg-black/65 text-white" aria-label={locale === "zh" ? "放大" : "Zoom in"}><Plus className="h-4 w-4" /></button></div>
          </div>
          <div className="safe-bottom border-t border-white/10 bg-page px-4 py-3 text-white"><p className="text-xs text-white/70">{activeContent.description}</p>{activeContent.applicableScope && <p className="mt-1 text-xs text-gold-light">{locale === "zh" ? "适用范围" : "Applicable scope"}: {activeContent.applicableScope}</p>}<p className="mt-1 text-xs text-white/50">{copy.fullDocs}</p></div>
        </div>
      )}
    </>
  );
}
