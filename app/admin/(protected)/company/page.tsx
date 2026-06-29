"use client";

import { useEffect, useState } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { useToast } from "@/components/admin/Toast";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { ImageUpload } from "@/components/admin/ImageUpload";
import type { CompanyProfile, Advantage } from "@/types/database";
import { Loader2, Save, Plus, Trash2 } from "lucide-react";

const defaultAdvantage: Advantage = {
  icon: "shield",
  title_cn: "",
  title_en: "",
  desc_cn: "",
  desc_en: "",
};

export default function CompanyPage() {
  const supabase = createBrowserSupabaseClient();
  const { show } = useToast();

  const [profileId, setProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    title_cn: "",
    title_en: "",
    description_cn: "",
    description_en: "",
    phone: "",
    email: "",
    whatsapp: "",
    address_cn: "",
    address_en: "",
    wechat_qr_url: "",
    logo_url: "",
  });
  const [advantagesCn, setAdvantagesCn] = useState<Advantage[]>([]);
  const [advantagesEn, setAdvantagesEn] = useState<Advantage[]>([]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("company_profile")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (data) {
        const p = data as CompanyProfile;
        setProfileId(p.id);
        setForm({
          title_cn: p.title_cn || "",
          title_en: p.title_en || "",
          description_cn: p.description_cn || "",
          description_en: p.description_en || "",
          phone: p.phone || "",
          email: p.email || "",
          whatsapp: p.whatsapp || "",
          address_cn: p.address_cn || "",
          address_en: p.address_en || "",
          wechat_qr_url: p.wechat_qr_url || "",
          logo_url: p.logo_url || "",
        });
        setAdvantagesCn(p.advantages_cn || []);
        setAdvantagesEn(p.advantages_en || []);
      }
      setLoading(false);
    })();
  }, [supabase]);

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((p) => ({ ...p, [key]: value }));
  }

  function updateAdvantage(
    lang: "cn" | "en",
    idx: number,
    field: keyof Advantage,
    value: string
  ) {
    const setter = lang === "cn" ? setAdvantagesCn : setAdvantagesEn;
    setter((prev) =>
      prev.map((a, i) => (i === idx ? { ...a, [field]: value } : a))
    );
  }

  function addAdvantage() {
    setAdvantagesCn((p) => [...p, { ...defaultAdvantage }]);
    setAdvantagesEn((p) => [...p, { ...defaultAdvantage }]);
  }

  function removeAdvantage(idx: number) {
    setAdvantagesCn((p) => p.filter((_, i) => i !== idx));
    setAdvantagesEn((p) => p.filter((_, i) => i !== idx));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);

    const payload = {
      title_cn: form.title_cn.trim() || null,
      title_en: form.title_en.trim() || null,
      description_cn: form.description_cn.trim() || null,
      description_en: form.description_en.trim() || null,
      advantages_cn: advantagesCn,
      advantages_en: advantagesEn,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      whatsapp: form.whatsapp.trim() || null,
      address_cn: form.address_cn.trim() || null,
      address_en: form.address_en.trim() || null,
      wechat_qr_url: form.wechat_qr_url || null,
      logo_url: form.logo_url || null,
    };

    const { error } = profileId
      ? await supabase.from("company_profile").update(payload).eq("id", profileId)
      : await supabase.from("company_profile").insert(payload);

    setSaving(false);
    if (error) {
      show(error.message, "error");
      return;
    }
    show("公司信息已保存", "success");
  }

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center text-gray-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-graphite">公司信息</h1>
        <p className="mt-1 text-sm text-gray-500">维护公司介绍、联系方式、Logo 与微信二维码</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* 品牌素材 */}
        <Section title="品牌素材" subtitle="Logo 与微信二维码">
          <ImageUpload
            label="品牌 Logo"
            folder="company/logo"
            value={form.logo_url}
            onChange={(url) => update("logo_url", url)}
            aspect="logo"
            hint="建议 3:1 横向比例"
          />
          <ImageUpload
            label="微信二维码"
            folder="company/wechat"
            value={form.wechat_qr_url}
            onChange={(url) => update("wechat_qr_url", url)}
            aspect="square"
            hint="用于前台联系页展示"
          />
        </Section>

        {/* 公司介绍 */}
        <Section title="公司介绍" subtitle="中英文标题与详细描述">
          <Input
            label="中文标题"
            value={form.title_cn}
            onChange={(e) => update("title_cn", e.target.value)}
          />
          <Input
            label="英文标题"
            value={form.title_en}
            onChange={(e) => update("title_en", e.target.value)}
          />
          <Textarea
            label="中文介绍"
            rows={5}
            value={form.description_cn}
            onChange={(e) => update("description_cn", e.target.value)}
          />
          <Textarea
            label="英文介绍"
            rows={5}
            value={form.description_en}
            onChange={(e) => update("description_en", e.target.value)}
          />
        </Section>

        {/* 核心优势 */}
        <Section title="核心优势" subtitle="中英文双语维护">
          <div className="space-y-3">
            {advantagesCn.map((adv, idx) => (
              <div
                key={idx}
                className="rounded-lg border border-gray-200 bg-gray-50 p-4"
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-500">优势 {idx + 1}</span>
                  <button
                    type="button"
                    onClick={() => removeAdvantage(idx)}
                    className="rounded-md p-1 text-red-500 hover:bg-red-50"
                    aria-label="删除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <Input
                    label="中文标题"
                    value={adv.title_cn}
                    onChange={(e) => updateAdvantage("cn", idx, "title_cn", e.target.value)}
                  />
                  <Input
                    label="英文标题"
                    value={advantagesEn[idx]?.title_en || ""}
                    onChange={(e) => updateAdvantage("en", idx, "title_en", e.target.value)}
                  />
                  <Textarea
                    label="中文描述"
                    rows={2}
                    value={adv.desc_cn}
                    onChange={(e) => updateAdvantage("cn", idx, "desc_cn", e.target.value)}
                  />
                  <Textarea
                    label="英文描述"
                    rows={2}
                    value={advantagesEn[idx]?.desc_en || ""}
                    onChange={(e) => updateAdvantage("en", idx, "desc_en", e.target.value)}
                  />
                  <Input
                    label="图标标识"
                    value={adv.icon}
                    onChange={(e) => {
                      updateAdvantage("cn", idx, "icon", e.target.value);
                      updateAdvantage("en", idx, "icon", e.target.value);
                    }}
                    placeholder="shield / factory / truck / globe"
                  />
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={addAdvantage}
              className="inline-flex items-center gap-1 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50"
            >
              <Plus className="h-3.5 w-3.5" /> 新增优势
            </button>
          </div>
        </Section>

        {/* 联系方式 */}
        <Section title="联系方式" subtitle="电话 / 邮箱 / WhatsApp / 地址">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              label="联系电话"
              value={form.phone}
              onChange={(e) => update("phone", e.target.value)}
              placeholder="+86 138-xxxx-xxxx"
            />
            <Input
              label="邮箱"
              type="email"
              value={form.email}
              onChange={(e) => update("email", e.target.value)}
            />
            <Input
              label="WhatsApp"
              value={form.whatsapp}
              onChange={(e) => update("whatsapp", e.target.value)}
              placeholder="+86 138-xxxx-xxxx"
            />
            <Input
              label="公司地址（中文）"
              value={form.address_cn}
              onChange={(e) => update("address_cn", e.target.value)}
            />
          </div>
          <Input
            label="公司地址（英文）"
            value={form.address_en}
            onChange={(e) => update("address_en", e.target.value)}
          />
        </Section>

        <div className="flex justify-end">
          <Button type="submit" loading={saving} disabled={saving}>
            <Save className="h-4 w-4" /> 保存公司信息
          </Button>
        </div>
      </form>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-100 sm:p-6">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-graphite">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-gray-400">{subtitle}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
