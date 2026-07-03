"use client";

import { useEffect, useState } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { useToast } from "@/components/admin/Toast";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import type { HomepageContent, HomeFeatureItem } from "@/types/database";
import { Loader2, Plus, Trash2, Save, ChevronUp, ChevronDown } from "lucide-react";

interface FormState {
  hero_eyebrow_cn: string;
  hero_eyebrow_en: string;
  hero_title_cn: string;
  hero_title_en: string;
  hero_highlight_cn: string;
  hero_highlight_en: string;
  hero_description_cn: string;
  hero_description_en: string;
  primary_cta_text_cn: string;
  primary_cta_text_en: string;
  secondary_cta_text_cn: string;
  secondary_cta_text_en: string;
  feature_section_title_cn: string;
  feature_section_title_en: string;
  feature_section_subtitle_cn: string;
  feature_section_subtitle_en: string;
  category_section_title_cn: string;
  category_section_subtitle_cn: string;
  featured_products_title_cn: string;
  featured_products_subtitle_cn: string;
  bottom_cta_title_cn: string;
  bottom_cta_title_en: string;
  bottom_cta_description_cn: string;
  bottom_cta_description_en: string;
  is_active: boolean;
}

const emptyForm: FormState = {
  hero_eyebrow_cn: "",
  hero_eyebrow_en: "",
  hero_title_cn: "",
  hero_title_en: "",
  hero_highlight_cn: "",
  hero_highlight_en: "",
  hero_description_cn: "",
  hero_description_en: "",
  primary_cta_text_cn: "",
  primary_cta_text_en: "",
  secondary_cta_text_cn: "",
  secondary_cta_text_en: "",
  feature_section_title_cn: "",
  feature_section_title_en: "",
  feature_section_subtitle_cn: "",
  feature_section_subtitle_en: "",
  category_section_title_cn: "",
  category_section_subtitle_cn: "",
  featured_products_title_cn: "",
  featured_products_subtitle_cn: "",
  bottom_cta_title_cn: "",
  bottom_cta_title_en: "",
  bottom_cta_description_cn: "",
  bottom_cta_description_en: "",
  is_active: true,
};

export default function HomepagePage() {
  const supabase = createBrowserSupabaseClient();
  const { show } = useToast();

  const [contentId, setContentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [featuresCn, setFeaturesCn] = useState<HomeFeatureItem[]>([]);
  const [featuresEn, setFeaturesEn] = useState<HomeFeatureItem[]>([]);

  useEffect(() => {
    (async () => {
      let data: HomepageContent | null = null;

      // 优先加载激活行
      const { data: active } = await supabase
        .from("homepage_content")
        .select("*")
        .eq("is_active", true)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      data = (active as HomepageContent | null) || null;

      // 若无激活行，尝试加载任意一行
      if (!data) {
        const { data: anyRow } = await supabase
          .from("homepage_content")
          .select("*")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        data = (anyRow as HomepageContent | null) || null;
      }

      if (data) {
        const h = data;
        setContentId(h.id);
        setForm({
          hero_eyebrow_cn: h.hero_eyebrow_cn || "",
          hero_eyebrow_en: h.hero_eyebrow_en || "",
          hero_title_cn: h.hero_title_cn || "",
          hero_title_en: h.hero_title_en || "",
          hero_highlight_cn: h.hero_highlight_cn || "",
          hero_highlight_en: h.hero_highlight_en || "",
          hero_description_cn: h.hero_description_cn || "",
          hero_description_en: h.hero_description_en || "",
          primary_cta_text_cn: h.primary_cta_text_cn || "",
          primary_cta_text_en: h.primary_cta_text_en || "",
          secondary_cta_text_cn: h.secondary_cta_text_cn || "",
          secondary_cta_text_en: h.secondary_cta_text_en || "",
          feature_section_title_cn: h.feature_section_title_cn || "",
          feature_section_title_en: h.feature_section_title_en || "",
          feature_section_subtitle_cn: h.feature_section_subtitle_cn || "",
          feature_section_subtitle_en: h.feature_section_subtitle_en || "",
          category_section_title_cn: h.category_section_title_cn || "",
          category_section_subtitle_cn: h.category_section_subtitle_cn || "",
          featured_products_title_cn: h.featured_products_title_cn || "",
          featured_products_subtitle_cn: h.featured_products_subtitle_cn || "",
          bottom_cta_title_cn: h.bottom_cta_title_cn || "",
          bottom_cta_title_en: h.bottom_cta_title_en || "",
          bottom_cta_description_cn: h.bottom_cta_description_cn || "",
          bottom_cta_description_en: h.bottom_cta_description_en || "",
          is_active: h.is_active,
        });
        setFeaturesCn(h.features_cn || []);
        setFeaturesEn(h.features_en || []);
      }
      setLoading(false);
    })();
  }, [supabase]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((p) => ({ ...p, [key]: value }));
  }

  // ===== features 数组编辑 =====
  function updateFeature(
    lang: "cn" | "en",
    idx: number,
    field: keyof HomeFeatureItem,
    value: string
  ) {
    const setter = lang === "cn" ? setFeaturesCn : setFeaturesEn;
    setter((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, [field]: value } : it))
    );
  }

  function addFeature(lang: "cn" | "en") {
    const setter = lang === "cn" ? setFeaturesCn : setFeaturesEn;
    setter((prev) => [...prev, { icon: "flame", title: "", description: "" }]);
  }

  function removeFeature(lang: "cn" | "en", idx: number) {
    const setter = lang === "cn" ? setFeaturesCn : setFeaturesEn;
    setter((prev) => prev.filter((_, i) => i !== idx));
  }

  function moveFeature(lang: "cn" | "en", idx: number, dir: -1 | 1) {
    const setter = lang === "cn" ? setFeaturesCn : setFeaturesEn;
    setter((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);

    const payload = {
      hero_eyebrow_cn: form.hero_eyebrow_cn.trim() || null,
      hero_eyebrow_en: form.hero_eyebrow_en.trim() || null,
      hero_title_cn: form.hero_title_cn.trim() || null,
      hero_title_en: form.hero_title_en.trim() || null,
      hero_highlight_cn: form.hero_highlight_cn.trim() || null,
      hero_highlight_en: form.hero_highlight_en.trim() || null,
      hero_description_cn: form.hero_description_cn.trim() || null,
      hero_description_en: form.hero_description_en.trim() || null,
      primary_cta_text_cn: form.primary_cta_text_cn.trim() || null,
      primary_cta_text_en: form.primary_cta_text_en.trim() || null,
      secondary_cta_text_cn: form.secondary_cta_text_cn.trim() || null,
      secondary_cta_text_en: form.secondary_cta_text_en.trim() || null,
      feature_section_title_cn: form.feature_section_title_cn.trim() || null,
      feature_section_title_en: form.feature_section_title_en.trim() || null,
      feature_section_subtitle_cn: form.feature_section_subtitle_cn.trim() || null,
      feature_section_subtitle_en: form.feature_section_subtitle_en.trim() || null,
      features_cn: featuresCn,
      features_en: featuresEn,
      category_section_title_cn: form.category_section_title_cn.trim() || null,
      category_section_subtitle_cn: form.category_section_subtitle_cn.trim() || null,
      featured_products_title_cn: form.featured_products_title_cn.trim() || null,
      featured_products_subtitle_cn: form.featured_products_subtitle_cn.trim() || null,
      bottom_cta_title_cn: form.bottom_cta_title_cn.trim() || null,
      bottom_cta_title_en: form.bottom_cta_title_en.trim() || null,
      bottom_cta_description_cn: form.bottom_cta_description_cn.trim() || null,
      bottom_cta_description_en: form.bottom_cta_description_en.trim() || null,
      is_active: form.is_active,
    };

    let errorMsg: string | null = null;
    if (contentId) {
      const { error } = await supabase
        .from("homepage_content")
        .update(payload)
        .eq("id", contentId);
      if (error) errorMsg = error.message;
    } else {
      const { data, error } = await supabase
        .from("homepage_content")
        .insert({ ...payload, is_active: true })
        .select("id")
        .single();
      if (error) {
        errorMsg = error.message;
      } else if (data) {
        setContentId((data as { id: string }).id);
      }
    }
    setSaving(false);
    if (errorMsg) {
      show(errorMsg, "error");
      return;
    }
    show(contentId ? "首页内容已保存" : "首页内容已创建", "success");
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
        <h1 className="text-xl font-bold text-graphite">首页内容</h1>
        <p className="mt-1 text-sm text-gray-500">
          编辑前台首页 Hero、核心优势、CTA 文案
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Hero 区域 */}
        <Section title="Hero 区域" subtitle="首页主视觉，中英文标题与描述">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              label="眉标（中文）"
              value={form.hero_eyebrow_cn}
              onChange={(e) => update("hero_eyebrow_cn", e.target.value)}
            />
            <Input
              label="眉标（英文）"
              value={form.hero_eyebrow_en}
              onChange={(e) => update("hero_eyebrow_en", e.target.value)}
            />
            <Input
              label="主标题（中文）"
              value={form.hero_title_cn}
              onChange={(e) => update("hero_title_cn", e.target.value)}
            />
            <Input
              label="主标题（英文）"
              value={form.hero_title_en}
              onChange={(e) => update("hero_title_en", e.target.value)}
            />
            <Input
              label="高亮词（中文）"
              value={form.hero_highlight_cn}
              onChange={(e) => update("hero_highlight_cn", e.target.value)}
              hint="标题中需要高亮显示的关键词"
            />
            <Input
              label="高亮词（英文）"
              value={form.hero_highlight_en}
              onChange={(e) => update("hero_highlight_en", e.target.value)}
            />
          </div>
          <Textarea
            label="描述（中文）"
            rows={3}
            value={form.hero_description_cn}
            onChange={(e) => update("hero_description_cn", e.target.value)}
          />
          <Textarea
            label="描述（英文）"
            rows={3}
            value={form.hero_description_en}
            onChange={(e) => update("hero_description_en", e.target.value)}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              label="主按钮文案（中文）"
              value={form.primary_cta_text_cn}
              onChange={(e) => update("primary_cta_text_cn", e.target.value)}
            />
            <Input
              label="主按钮文案（英文）"
              value={form.primary_cta_text_en}
              onChange={(e) => update("primary_cta_text_en", e.target.value)}
            />
            <Input
              label="次按钮文案（中文）"
              value={form.secondary_cta_text_cn}
              onChange={(e) => update("secondary_cta_text_cn", e.target.value)}
            />
            <Input
              label="次按钮文案（英文）"
              value={form.secondary_cta_text_en}
              onChange={(e) => update("secondary_cta_text_en", e.target.value)}
            />
          </div>
        </Section>

        {/* 核心优势区块 */}
        <Section title="核心优势区块" subtitle="区块标题与中英文优势卡片">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              label="区块标题（中文）"
              value={form.feature_section_title_cn}
              onChange={(e) => update("feature_section_title_cn", e.target.value)}
            />
            <Input
              label="区块标题（英文）"
              value={form.feature_section_title_en}
              onChange={(e) => update("feature_section_title_en", e.target.value)}
            />
            <Input
              label="区块副标题（中文）"
              value={form.feature_section_subtitle_cn}
              onChange={(e) => update("feature_section_subtitle_cn", e.target.value)}
            />
            <Input
              label="区块副标题（英文）"
              value={form.feature_section_subtitle_en}
              onChange={(e) => update("feature_section_subtitle_en", e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <FeatureListEditor
              lang="cn"
              title="中文优势卡片"
              items={featuresCn}
              onUpdate={updateFeature}
              onAdd={addFeature}
              onRemove={removeFeature}
              onMove={moveFeature}
            />
            <FeatureListEditor
              lang="en"
              title="英文优势卡片"
              items={featuresEn}
              onUpdate={updateFeature}
              onAdd={addFeature}
              onRemove={removeFeature}
              onMove={moveFeature}
            />
          </div>
        </Section>

        {/* 类目与产品区 */}
        <Section title="类目与产品区" subtitle="前台类目与精选产品区块标题（仅中文）">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              label="类目区块标题"
              value={form.category_section_title_cn}
              onChange={(e) => update("category_section_title_cn", e.target.value)}
            />
            <Input
              label="类目区块副标题"
              value={form.category_section_subtitle_cn}
              onChange={(e) => update("category_section_subtitle_cn", e.target.value)}
            />
            <Input
              label="精选产品区块标题"
              value={form.featured_products_title_cn}
              onChange={(e) => update("featured_products_title_cn", e.target.value)}
            />
            <Input
              label="精选产品区块副标题"
              value={form.featured_products_subtitle_cn}
              onChange={(e) => update("featured_products_subtitle_cn", e.target.value)}
            />
          </div>
        </Section>

        {/* 底部 CTA */}
        <Section title="底部 CTA" subtitle="页面底部号召文案">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              label="CTA 标题（中文）"
              value={form.bottom_cta_title_cn}
              onChange={(e) => update("bottom_cta_title_cn", e.target.value)}
            />
            <Input
              label="CTA 标题（英文）"
              value={form.bottom_cta_title_en}
              onChange={(e) => update("bottom_cta_title_en", e.target.value)}
            />
          </div>
          <Textarea
            label="CTA 描述（中文）"
            rows={2}
            value={form.bottom_cta_description_cn}
            onChange={(e) => update("bottom_cta_description_cn", e.target.value)}
          />
          <Textarea
            label="CTA 描述（英文）"
            rows={2}
            value={form.bottom_cta_description_en}
            onChange={(e) => update("bottom_cta_description_en", e.target.value)}
          />
        </Section>

        {/* 状态 */}
        <Section title="发布状态" subtitle="前台是否展示此版本">
          <button
            type="button"
            onClick={() => update("is_active", !form.is_active)}
            className={`inline-flex h-11 items-center gap-2 rounded-lg border px-4 text-sm ${
              form.is_active
                ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                : "border-gray-200 bg-white text-gray-500"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                form.is_active ? "bg-emerald-500" : "bg-gray-300"
              }`}
            />
            {form.is_active ? "前台启用" : "未启用"}
          </button>
        </Section>

        <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-2 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:px-5">
          <Button type="submit" loading={saving} disabled={saving}>
            <Save className="h-4 w-4" /> 保存首页内容
          </Button>
        </div>
      </form>
    </div>
  );
}

// ============================================================
// 子组件：优势卡片列表编辑器
// ============================================================
function FeatureListEditor({
  lang,
  title,
  items,
  onUpdate,
  onAdd,
  onRemove,
  onMove,
}: {
  lang: "cn" | "en";
  title: string;
  items: HomeFeatureItem[];
  onUpdate: (
    lang: "cn" | "en",
    idx: number,
    field: keyof HomeFeatureItem,
    value: string
  ) => void;
  onAdd: (lang: "cn" | "en") => void;
  onRemove: (lang: "cn" | "en", idx: number) => void;
  onMove: (lang: "cn" | "en", idx: number, dir: -1 | 1) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-500">{title}</span>
        <button
          type="button"
          onClick={() => onAdd(lang)}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
        >
          <Plus className="h-3 w-3" /> 添加优势卡片
        </button>
      </div>
      {items.length === 0 && (
        <p className="text-xs text-gray-400">暂无卡片</p>
      )}
      {items.map((item, idx) => (
        <div
          key={idx}
          className="rounded-lg border border-gray-200 bg-gray-50 p-4"
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs text-gray-400">卡片 {idx + 1}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onMove(lang, idx, -1)}
                disabled={idx === 0}
                className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                aria-label="上移"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onMove(lang, idx, 1)}
                disabled={idx === items.length - 1}
                className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                aria-label="下移"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onRemove(lang, idx)}
                className="rounded p-1 text-red-500 hover:bg-red-50"
                aria-label="删除"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="space-y-3">
            <Input
              label="图标标识"
              value={item.icon}
              onChange={(e) => onUpdate(lang, idx, "icon", e.target.value)}
              hint="flame/leaf/truck/globe 等"
            />
            <Input
              label="标题"
              value={item.title}
              onChange={(e) => onUpdate(lang, idx, "title", e.target.value)}
            />
            <Textarea
              label="描述"
              rows={2}
              value={item.description}
              onChange={(e) => onUpdate(lang, idx, "description", e.target.value)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// 子组件：分区块容器
// ============================================================
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
