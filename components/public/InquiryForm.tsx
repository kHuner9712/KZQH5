"use client";

import { useState } from "react";
import { Input, Textarea } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { CheckCircle2, AlertCircle } from "lucide-react";
import type { InquiryInput } from "@/types/database";

interface FormState extends InquiryInput {
  honeypot?: string;
}

const initialState: FormState = {
  name: "",
  company: "",
  country: "",
  email: "",
  whatsapp: "",
  interested_product: "",
  quantity: "",
  message: "",
};

export function InquiryForm({ defaultProduct }: { defaultProduct?: string }) {
  const [form, setForm] = useState<FormState>({
    ...initialState,
    interested_product: defaultProduct || "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key as string]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key as string];
        return next;
      });
    }
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = "请填写您的姓名";
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      e.email = "邮箱格式不正确";
    }
    // 至少留一种联系方式（邮箱或 WhatsApp）
    if (!form.email && !form.whatsapp) {
      e.email = "请至少填写邮箱或 WhatsApp 之一，方便我们联系您";
    }
    if (form.honeypot) {
      // 蜜罐触发，静默失败
      return false;
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setStatus("loading");
    setErrorMsg("");

    try {
      const { honeypot, ...payload } = form;
      const res = await fetch("/api/inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || "提交失败，请稍后重试");
      }

      setStatus("success");
      setForm({ ...initialState });
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "提交失败，请稍后重试");
    }
  }

  if (status === "success") {
    return (
      <div className="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-gray-100">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50">
          <CheckCircle2 className="h-7 w-7 text-emerald-500" />
        </div>
        <h3 className="mt-4 text-base font-semibold text-graphite">
          询盘提交成功
        </h3>
        <p className="mt-1.5 text-sm text-gray-500">
          感谢您的询盘，我们的销售团队会尽快与您联系。
        </p>
        <Button
          variant="secondary"
          className="mt-5"
          onClick={() => setStatus("idle")}
        >
          继续提交新询盘
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* 蜜罐（防垃圾） */}
      <input
        type="text"
        name="company_website"
        value={form.honeypot}
        onChange={(e) => update("honeypot", e.target.value)}
        className="hidden"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
      />

      <div className="grid grid-cols-1 gap-4">
        <Input
          label="姓名"
          name="name"
          required
          placeholder="您的姓名"
          value={form.name}
          onChange={(e) => update("name", e.target.value)}
          error={errors.name}
        />
        <Input
          label="公司"
          name="company"
          placeholder="公司名称（选填）"
          value={form.company}
          onChange={(e) => update("company", e.target.value)}
        />
        <Input
          label="国家 / 地区"
          name="country"
          placeholder="例如：United States / UAE"
          value={form.country}
          onChange={(e) => update("country", e.target.value)}
        />
        <Input
          label="邮箱"
          name="email"
          type="email"
          placeholder="you@example.com"
          value={form.email}
          onChange={(e) => update("email", e.target.value)}
          error={errors.email}
        />
        <Input
          label="WhatsApp"
          name="whatsapp"
          placeholder="+1 555 123 4567"
          value={form.whatsapp}
          onChange={(e) => update("whatsapp", e.target.value)}
        />
        <Input
          label="感兴趣产品"
          name="interested_product"
          placeholder="产品名称或规格"
          value={form.interested_product}
          onChange={(e) => update("interested_product", e.target.value)}
        />
        <Input
          label="采购数量"
          name="quantity"
          placeholder="例如：1×20GP / 5000 sqm"
          value={form.quantity}
          onChange={(e) => update("quantity", e.target.value)}
        />
        <Textarea
          label="询盘留言"
          name="message"
          rows={4}
          placeholder="请描述您的需求，例如规格、用途、目的港、贸易条款等…"
          value={form.message}
          onChange={(e) => update("message", e.target.value)}
        />
      </div>

      {status === "error" && (
        <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      <Button type="submit" size="lg" className="w-full" loading={status === "loading"}>
        提交询盘
      </Button>

      <p className="text-center text-[11px] text-gray-400">
        我们仅会使用您填写的信息用于本次询盘回复，不会泄露给第三方。
      </p>
    </form>
  );
}
