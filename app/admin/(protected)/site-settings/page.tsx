"use client";

import { useEffect, useState } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { useToast } from "@/components/admin/Toast";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { ImageUpload } from "@/components/admin/ImageUpload";
import type { SiteSettings, NavItem } from "@/types/database";
import { Loader2, Plus, Trash2, Save, ChevronUp, ChevronDown } from "lucide-react";

interface FormState {
  site_name: string;
  site_name_cn: string;
  site_name_en: string;
  brand_name: string;
  default_language: string;
  global_meta_title_cn: string;
  global_meta_title_en: string;
  global_meta_description_cn: string;
  global_meta_description_en: string;
  default_og_image_url: string;
  footer_text_cn: string;
  footer_text_en: string;
}

const emptyForm: FormState = {
  site_name: "",
  site_name_cn: "",
  site_name_en: "",
  brand_name: "",
  default_language: "zh",
  global_meta_title_cn: "",
  global_meta_title_en: "",
  global_meta_description_cn: "",
  global_meta_description_en: "",
  default_og_image_url: "",
  footer_text_cn: "",
  footer_text_en: "",
};

export default function SiteSettingsPage() {
  const supabase = createBrowserSupabaseClient();
  const { show } = useToast();

  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [navItems, setNavItems] = useState<NavItem[]>([]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("site_settings")
        .select("*")
        .limit(1)
        .maybeSingle();

      if (data) {
        const s = data as SiteSettings;
        setSettingsId(s.id);
        setForm({
          site_name: s.site_name || "",
          site_name_cn: s.site_name_cn || "",
          site_name_en: s.site_name_en || "",
          brand_name: s.brand_name || "",
          default_language: s.default_language || "zh",
          global_meta_title_cn: s.global_meta_title_cn || "",
          global_meta_title_en: s.global_meta_title_en || "",
          global_meta_description_cn: s.global_meta_description_cn || "",
          global_meta_description_en: s.global_meta_description_en || "",
          default_og_image_url: s.default_og_image_url || "",
          footer_text_cn: s.footer_text_cn || "",
          footer_text_en: s.footer_text_en || "",
        });
        setNavItems(s.navigation_json || []);
      }
      setLoading(false);
    })();
  }, [supabase]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((p) => ({ ...p, [key]: value }));
  }

  function updateNavItem(idx: number, field: keyof NavItem, value: string) {
    setNavItems((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, [field]: value } : it))
    );
  }

  function addNavItem() {
    setNavItems((prev) => [
      ...prev,
      {
        label_cn: "",
        label_en: "",
        href: "/",
        sort_order: prev.length,
      },
    ]);
  }

  function removeNavItem(idx: number) {
    setNavItems((prev) => prev.filter((_, i) => i !== idx));
  }

  function moveNavItem(idx: number, dir: -1 | 1) {
    setNavItems((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next.map((it, i) => ({ ...it, sort_order: i }));
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.site_name.trim()) {
      show("请填写站点名称（site_name）", "error");
      return;
    }
    setSaving(true);

    const payload = {
      site_name: form.site_name.trim(),
      site_name_cn: form.site_name_cn.trim() || null,
      site_name_en: form.site_name_en.trim() || null,
      brand_name: form.brand_name.trim() || null,
      default_language: form.default_language || "zh",
      global_meta_title_cn: form.global_meta_title_cn.trim() || null,
      global_meta_title_en: form.global_meta_title_en.trim() || null,
      global_meta_description_cn: form.global_meta_description_cn.trim() || null,
      global_meta_description_en: form.global_meta_description_en.trim() || null,
      default_og_image_url: form.default_og_image_url || null,
      footer_text_cn: form.footer_text_cn.trim() || null,
      footer_text_en: form.footer_text_en.trim() || null,
      navigation_json: navItems,
    };

    if (settingsId) {
      const { error } = await supabase
        .from("site_settings")
        .update(payload)
        .eq("id", settingsId);
      setSaving(false);
      if (error) {
        show(error.message, "error");
        return;
      }
      show("站点设置已保存", "success");
    } else {
      const { data, error } = await supabase
        .from("site_settings")
        .insert(payload)
        .select("id")
        .single();
      setSaving(false);
      if (error || !data) {
        show(error?.message || "保存失败", "error");
        return;
      }
      setSettingsId((data as { id: string }).id);
      show("站点设置已创建", "success");
    }
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
        <h1 className="text-xl font-bold text-graphite">站点设置</h1>
        <p className="mt-1 text-sm text-gray-500">
          站点名称、品牌、默认语言、SEO 元信息、OG 图与导航菜单
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Section title="站点信息" subtitle="站点名称、品牌与默认语言">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              label="站点名称 (site_name)"
              required
              value={form.site_name}
              onChange={(e) => update("site_name", e.target.value)}
              hint="系统内部标识"
            />
            <Input
              label="品牌名称 (brand_name)"
              value={form.brand_name}
              onChange={(e) => update("brand_name", e.target.value)}
            />
            <Input
              label="站点名称（中文）"
              value={form.site_name_cn}
              onChange={(e) => update("site_name_cn", e.target.value)}
            />
            <Input
              label="站点名称（英文）"
              value={form.site_name_en}
              onChange={(e) => update("site_name_en", e.target.value)}
            />
            <div className="space-y-1.5">
              <label className="block text-[12px] font-medium text-ink-soft">
                默认语言
              </label>
              <select
                value={form.default_language}
                onChange={(e) => update("default_language", e.target.value)}
                className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-graphite outline-none focus:border-steel focus:ring-2 focus:ring-steel/20"
              >
                <option value="zh">中文 (zh)</option>
                <option value="en">English (en)</option>
              </select>
            </div>
          </div>
        </Section>

        <Section title="全局 SEO 元信息" subtitle="中英文 meta title / description">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              label="Meta Title（中文）"
              value={form.global_meta_title_cn}
              onChange={(e) => update("global_meta_title_cn", e.target.value)}
            />
            <Input
              label="Meta Title（英文）"
              value={form.global_meta_title_en}
              onChange={(e) => update("global_meta_title_en", e.target.value)}
            />
          </div>
          <Textarea
            label="Meta Description（中文）"
            rows={3}
            value={form.global_meta_description_cn}
            onChange={(e) => update("global_meta_description_cn", e.target.value)}
          />
          <Textarea
            label="Meta Description（英文）"
            rows={3}
            value={form.global_meta_description_en}
            onChange={(e) => update("global_meta_description_en", e.target.value)}
          />
          <ImageUpload
            label="默认 OG 分享图"
            folder="site/og"
            value={form.default_og_image_url}
            onChange={(url) => update("default_og_image_url", url)}
            aspect="wide"
            hint="建议 1200×630，用于社交分享卡片"
          />
        </Section>

        <Section title="页脚文案" subtitle="中英文页脚版权信息">
          <Input
            label="页脚文案（中文）"
            value={form.footer_text_cn}
            onChange={(e) => update("footer_text_cn", e.target.value)}
          />
          <Input
            label="页脚文案（英文）"
            value={form.footer_text_en}
            onChange={(e) => update("footer_text_en", e.target.value)}
          />
        </Section>

        <Section title="导航菜单" subtitle="顶部导航项，可拖动排序">
          <div className="space-y-3">
            {navItems.length === 0 && (
              <p className="text-xs text-gray-400">暂无导航项，点击下方按钮添加</p>
            )}
            {navItems.map((item, idx) => (
              <div
                key={idx}
                className="rounded-lg border border-gray-200 bg-gray-50 p-4"
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-500">
                    导航项 {idx + 1}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveNavItem(idx, -1)}
                      disabled={idx === 0}
                      className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                      aria-label="上移"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveNavItem(idx, 1)}
                      disabled={idx === navItems.length - 1}
                      className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                      aria-label="下移"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeNavItem(idx)}
                      className="rounded p-1 text-red-500 hover:bg-red-50"
                      aria-label="删除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <Input
                    label="中文标签"
                    value={item.label_cn}
                    onChange={(e) => updateNavItem(idx, "label_cn", e.target.value)}
                  />
                  <Input
                    label="英文标签"
                    value={item.label_en}
                    onChange={(e) => updateNavItem(idx, "label_en", e.target.value)}
                  />
                  <Input
                    label="链接 (href)"
                    value={item.href}
                    onChange={(e) => updateNavItem(idx, "href", e.target.value)}
                    placeholder="/products 或 /about"
                  />
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={addNavItem}
              className="inline-flex items-center gap-1 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50"
            >
              <Plus className="h-3.5 w-3.5" /> 添加导航项
            </button>
          </div>
        </Section>

        <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-2 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:px-5">
          <Button type="submit" loading={saving} disabled={saving}>
            <Save className="h-4 w-4" /> 保存站点设置
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
