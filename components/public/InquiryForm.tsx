"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Input, Textarea } from "@/components/ui/Input";
import { readInquiryAttribution } from "@/lib/client/inquiry-attribution";
import { localePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import type { InquiryInput } from "@/types/database";
import { InquiryListEditor } from "@/components/public/inquiry-list/InquiryListEditor";
import { useInquiryList } from "@/components/public/inquiry-list/InquiryListProvider";
import { trackAnalyticsEvent } from "@/lib/client/analytics";

interface ProductContext {
  id?: string;
  slug?: string;
  name?: string;
  pageUrl?: string;
}

interface FormState extends InquiryInput {
  honeypot?: string;
  privacy_accepted: boolean;
}

function createEmptyForm(locale: Locale, productName = ""): FormState {
  return {
    locale,
    name: "",
    company: "",
    country: "",
    phone: "",
    wechat: "",
    email: "",
    whatsapp: "",
    interested_product: productName,
    quantity: "",
    destination_port: "",
    trade_term: "",
    message: "",
    privacy_accepted: false,
  };
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!contentType.toLowerCase().includes("application/json") || !text) {
    throw new Error("NON_JSON_RESPONSE");
  }
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error("NON_JSON_RESPONSE"); }
}

export function InquiryForm({
  defaultProduct,
  productContext,
  locale = "zh",
}: {
  defaultProduct?: string;
  productContext?: ProductContext;
  locale?: Locale;
}) {
  const copy = getDictionary(locale).form;
  const { items, clear } = useInquiryList();
  const productName = productContext?.name || defaultProduct || "";
  const [form, setForm] = useState<FormState>(() => createEmptyForm(locale, productName));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [submittedProductCount, setSubmittedProductCount] = useState(0);
  const submissionInFlight = useRef(false);
  const inquiryStarted = useRef(false);
  const selectedProductNames = items.map((item) => locale === "en" ? item.name_en || item.name_cn : item.name_cn).join(locale === "zh" ? "；" : "; ");

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[key as string];
      if (["phone", "wechat", "email", "whatsapp"].includes(key as string)) delete next.contact;
      return next;
    });
  }

  function validate() {
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = copy.nameRequired;
    if (!(selectedProductNames || form.interested_product)?.trim()) next.interested_product = copy.productRequired;
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) next.email = copy.invalidEmail;
    if (locale === "zh" && !form.phone?.trim() && !form.wechat?.trim()) next.contact = copy.contactRequired;
    if (locale === "en" && !form.email?.trim() && !form.whatsapp?.trim()) next.contact = copy.contactRequired;
    if (!form.privacy_accepted) next.privacy_accepted = copy.privacyRequired;
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submissionInFlight.current) return;
    if (!validate()) {
      window.setTimeout(() => document.querySelector<HTMLElement>("[aria-invalid='true']")?.focus(), 0);
      return;
    }
    submissionInFlight.current = true;
    setStatus("loading");
    setErrorMessage("");

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const attribution = readInquiryAttribution();
      const response = await fetch("/api/inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept-Language": locale },
        body: JSON.stringify({
          ...form,
          interested_product: selectedProductNames || form.interested_product,
          ...attribution,
          locale,
          product_id: productContext?.id,
          product_slug: productContext?.slug,
          page_url: productContext?.pageUrl || window.location.href,
          referrer: attribution.referrer || document.referrer || undefined,
          company_website: form.honeypot,
          items,
        }),
        signal: controller.signal,
      });
      const data = await readJsonResponse(response);
      if (!response.ok || data.success !== true) throw new Error(typeof data.error === "string" ? data.error : copy.submitError);
      setStatus("success");
      setSubmittedProductCount(Number(data.submittedProductCount) || items.length);
      trackAnalyticsEvent({ event_name: "inquiry_success", locale, product_id: productContext?.id || null });
      if (items.length) clear();
      setForm(createEmptyForm(locale, productName));
    } catch (error) {
      setStatus("error");
      const fallback = locale === "zh" ? "提交失败，请检查网络后重试" : "Submission failed. Check your connection and try again.";
      const timeoutMessage = locale === "zh" ? "提交超时，请检查网络后重试。请勿重复提交。" : "Submission timed out. Check your connection and retry without submitting repeatedly.";
      const responseMessage = locale === "zh" ? "服务返回异常，请稍后重试。" : "The service returned an invalid response. Please try again.";
      setErrorMessage(error instanceof DOMException && error.name === "AbortError"
        ? timeoutMessage
        : error instanceof Error && error.message === "NON_JSON_RESPONSE"
          ? responseMessage
          : error instanceof Error ? error.message : fallback);
    } finally {
      window.clearTimeout(timeout);
      submissionInFlight.current = false;
    }
  }

  if (status === "success") {
    return (
      <div className="card-base p-8 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50"><CheckCircle2 className="h-7 w-7 text-emerald-500" /></div>
        <h3 className="mt-4 text-base font-semibold text-ink">{copy.success}</h3>
        <p className="mt-1.5 text-sm text-ink-soft">{copy.successMessage}</p>
        {submittedProductCount > 0 && <p className="mt-2 text-xs font-medium text-gold-dark">{locale === "zh" ? `已提交 ${submittedProductCount} 个产品` : `${submittedProductCount} product${submittedProductCount === 1 ? "" : "s"} submitted`}</p>}
        <button type="button" onClick={() => setStatus("idle")} className="btn-outline mt-5 h-11 px-5 text-sm">{copy.submitAnother}</button>
      </div>
    );
  }

  return (
    <><InquiryListEditor locale={locale} /><form onSubmit={handleSubmit} onFocus={() => { if (!inquiryStarted.current) { inquiryStarted.current = true; trackAnalyticsEvent({ event_name: "inquiry_start", locale, product_id: productContext?.id || null }); } }} className="space-y-4" noValidate aria-busy={status === "loading"}>
      <input type="text" name="company_website" value={form.honeypot || ""} onChange={(event) => update("honeypot", event.target.value)} className="hidden" tabIndex={-1} autoComplete="off" aria-hidden="true" />
      <div className="grid grid-cols-1 gap-4">
        <Input label={copy.name} name="name" required placeholder={copy.namePlaceholder} value={form.name} onChange={(event) => update("name", event.target.value)} error={errors.name} />
        <Input label={copy.company} name="company" placeholder={copy.companyPlaceholder} value={form.company} onChange={(event) => update("company", event.target.value)} />

        {locale === "zh" ? (
          <>
            <Input label={copy.phone} name="phone" type="tel" placeholder={copy.phonePlaceholder} value={form.phone} onChange={(event) => update("phone", event.target.value)} error={errors.contact} />
            <Input label={copy.wechat} name="wechat" placeholder={copy.wechatPlaceholder} value={form.wechat} onChange={(event) => update("wechat", event.target.value)} />
            <Input label={copy.email} name="email" type="email" placeholder="you@example.com" value={form.email} onChange={(event) => update("email", event.target.value)} error={errors.email} />
            <Input label={copy.country} name="country" placeholder={copy.countryPlaceholder} value={form.country} onChange={(event) => update("country", event.target.value)} />
          </>
        ) : (
          <>
            <Input label={copy.country} name="country" placeholder={copy.countryPlaceholder} value={form.country} onChange={(event) => update("country", event.target.value)} />
            <Input label={copy.phone} name="phone" type="tel" placeholder={copy.phonePlaceholder} value={form.phone} onChange={(event) => update("phone", event.target.value)} />
            <Input label={copy.email} name="email" type="email" placeholder="you@example.com" value={form.email} onChange={(event) => update("email", event.target.value)} error={errors.email || errors.contact} />
            <Input label="WhatsApp" name="whatsapp" type="tel" placeholder="+1 555 123 4567" value={form.whatsapp} onChange={(event) => update("whatsapp", event.target.value)} />
          </>
        )}

        <Input label={copy.product} name="interested_product" required placeholder={copy.productPlaceholder} value={selectedProductNames || form.interested_product} onChange={(event) => update("interested_product", event.target.value)} disabled={items.length > 0} error={errors.interested_product} />
        <Input label={copy.quantity} name="quantity" placeholder={copy.quantityPlaceholder} value={form.quantity} onChange={(event) => update("quantity", event.target.value)} />

        {locale === "en" && (
          <>
            <Input label={copy.destinationPort} name="destination_port" placeholder="Ningbo / Rotterdam" value={form.destination_port} onChange={(event) => update("destination_port", event.target.value)} />
            <Input label={copy.tradeTerm} name="trade_term" placeholder="FOB / CIF" value={form.trade_term} onChange={(event) => update("trade_term", event.target.value)} />
          </>
        )}

        <Textarea label={copy.message} name="message" rows={4} placeholder={copy.messagePlaceholder} value={form.message} onChange={(event) => update("message", event.target.value)} />
      </div>

      <label className="flex min-h-11 cursor-pointer items-start gap-3 text-xs leading-5 text-ink-soft">
        <input id="privacy-accepted" type="checkbox" checked={form.privacy_accepted} onChange={(event) => update("privacy_accepted", event.target.checked)} aria-invalid={errors.privacy_accepted ? true : undefined} aria-describedby={errors.privacy_accepted ? "privacy-accepted-error" : undefined} className="mt-1 h-4 w-4 shrink-0 accent-industrial" />
        <span>{copy.privacyAgree} <Link href={localePath(locale, "/privacy")} className="underline hover:text-industrial">{getDictionary(locale).footer.privacy}</Link></span>
      </label>
      {errors.privacy_accepted && <p id="privacy-accepted-error" className="text-xs text-red-600" role="alert">{errors.privacy_accepted}</p>}
      <div aria-live="assertive">{status === "error" && <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{errorMessage}</span></div>}</div>
      <button type="submit" disabled={status === "loading"} className="btn-primary h-12 w-full text-sm disabled:opacity-60">{status === "loading" ? copy.submitting : copy.submit}</button>
      <p className="text-center text-[11px] text-ink-mute">{copy.privacy}</p>
    </form></>
  );
}
