"use client";

import { cn } from "@/lib/utils";
import { ArrowRight, Mail, MapPin, MessageCircle, Phone } from "lucide-react";
import { trackAnalyticsEvent } from "@/lib/client/analytics";

interface ContactCardProps {
  icon: "phone" | "email" | "whatsapp" | "address";
  label: string;
  value: string;
  href?: string;
  external?: boolean;
  className?: string;
}

/**
 * 联系方式卡片
 * - 图标 + 标签 + 值
 * - 有 href 时整卡可点击
 */
export function ContactCard({
  icon,
  label,
  value,
  href,
  external,
  className,
}: ContactCardProps) {
  const Icon = { phone: Phone, email: Mail, whatsapp: MessageCircle, address: MapPin }[icon];
  const content = (
    <div
      className={cn(
        "card-base flex items-center gap-3 p-3.5",
        href && "active:bg-canvas-warm",
        className
      )}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-industrial-50">
        <Icon className="h-4 w-4 text-industrial" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] text-ink-mute">{label}</p>
        <p className="mt-0.5 break-all text-[13px] font-medium text-ink">
          {value}
        </p>
      </div>
      {href && (
        <ArrowRight className="h-4 w-4 shrink-0 text-ink-mute" />
      )}
    </div>
  );

  if (!href) return <div>{content}</div>;

  return (
    <a
      href={href}
      onClick={() => {
        const eventName = href.startsWith("tel:")
          ? "phone_click"
          : href.startsWith("mailto:")
            ? "email_click"
            : href.includes("wa.me")
              ? "whatsapp_click"
              : null;
        if (eventName) trackAnalyticsEvent({ event_name: eventName });
      }}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
    >
      {content}
    </a>
  );
}
