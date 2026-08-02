"use client";

import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { ImageUpload } from "@/components/admin/ImageUpload";
import { useToast } from "@/components/admin/Toast";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import {
  getHomepageContentApi,
  saveHomepageContentApi,
} from "@/lib/services/admin-fetch";
import type { HomeFeatureItem } from "@/types/database";
import type { HomeHeroSlide } from "@/types/homepage";

const CONTENT_ERROR_TEXT: Record<string, string> = {
  ADMIN_WRITE_UNAUTHORIZED: "未登录或会话已过期",
  ADMIN_WRITE_FORBIDDEN_ORIGIN: "请求来源被拒绝",
  ADMIN_WRITE_FORBIDDEN_ROLE: "权限不足",
  ADMIN_WRITE_BAD_REQUEST: "参数错误，请检查轮播图、链接和文案",
  ADMIN_WRITE_CONFLICT: "数据已被他人更新，请刷新后重试",
  ADMIN_WRITE_FAILED: "操作失败",
  ADMIN_WRITE_NETWORK: "网络错误",
  ADMIN_WRITE_DEMO: "Demo 模式下不可写",
};

function errorText(code: string): string {
  return CONTENT_ERROR_TEXT[code] ?? "操作失败";
}

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
  category_section_title_en: string;
  category_section_subtitle_cn: string;
  category_section_subtitle_en: string;
  featured_products_title_cn: string;
  featured_products_title_en: string;
  featured_products_subtitle_cn: string;
  featured_products_subtitle_en: string;
  certificates_section_title_cn: string;
  certificates_section_title_en: string;
  certificates_note_cn: string;
  certificates_note_en: string;
  projects_section_title_cn: string;
  projects_section_title_en: string;
  projects_section_subtitle_cn: string;
  projects_section_subtitle_en: string;
  bottom_cta_eyebrow_cn: string;
  bottom_cta_eyebrow_en: string;
  bottom_cta_title_cn: string;
  bottom_cta_title_en: string;
  bottom_cta_description_cn: string;
  bottom_cta_description_en: string;
  bottom_cta_button_text_cn: string;
  bottom_cta_button_text_en: string;
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
  category_section_title_en: "",
  category_section_subtitle_cn: "",
  category_section_subtitle_en: "",
  featured_products_title_cn: "",
  featured_products_title_en: "",
  featured_products_subtitle_cn: "",
  featured_products_subtitle_en: "",
  certificates_section_title_cn: "",
  certificates_section_title_en: "",
  certificates_note_cn: "",
  certificates_note_en: "",
  projects_section_title_cn: "",
  projects_section_title_en: "",
  projects_section_subtitle_cn: "",
  projects_section_subtitle_en: "",
  bottom_cta_eyebrow_cn: "",
  bottom_cta_eyebrow_en: "",
  bottom_cta_title_cn: "",
  bottom_cta_title_en: "",
  bottom_cta_description_cn: "",
  bottom_cta_description_en: "",
  bottom_cta_button_text_cn: "",
  bottom_cta_button_text_en: "",
  is_active: true,
};

function createSlide(): HomeHeroSlide {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `slide-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    enabled: true,
    desktop_image_url: "",
    mobile_image_url: null,
    alt_cn: null,
    alt_en: null,
    eyebrow_cn: null,
    eyebrow_en: null,
    title_cn: null,
    title_en: null,
    highlight_cn: null,
    highlight_en: null,
    description_cn: null,
    description_en: null,
    primary_cta_text_cn: null,
    primary_cta_text_en: null,
    primary_cta_href: "/products",
    secondary_cta_text_cn: null,
    secondary_cta_text_en: null,
    secondary_cta_href: "/contact",
    focal_x: 50,
    focal_y: 50,
    overlay_opacity: 0.42,
  };
}

function text(value: string | null | undefined): string {
  return value || "";
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export default function HomepagePage() {
  const { show } = useToast();
  const [contentId, setContentId] = useState<string | null>(null);
  const [contentUpdatedAt, setContentUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [heroSlides, setHeroSlides] = useState<HomeHeroSlide[]>([]);
  const [featuresCn, setFeaturesCn] = useState<HomeFeatureItem[]>([]);
  const [featuresEn, setFeaturesEn] = useState<HomeFeatureItem[]>([]);

  useEffect(() => {
    void (async () => {
      const result = await getHomepageContentApi();
      if (result.ok && result.data.content) {
        const h = result.data.content;
        setContentId(h.id);
        setContentUpdatedAt(h.updated_at);
        setForm({
          hero_eyebrow_cn: text(h.hero_eyebrow_cn),
          hero_eyebrow_en: text(h.hero_eyebrow_en),
          hero_title_cn: text(h.hero_title_cn),
          hero_title_en: text(h.hero_title_en),
          hero_highlight_cn: text(h.hero_highlight_cn),
          hero_highlight_en: text(h.hero_highlight_en),
          hero_description_cn: text(h.hero_description_cn),
          hero_description_en: text(h.hero_description_en),
          primary_cta_text_cn: text(h.primary_cta_text_cn),
          primary_cta_text_en: text(h.primary_cta_text_en),
          secondary_cta_text_cn: text(h.secondary_cta_text_cn),
          secondary_cta_text_en: text(h.secondary_cta_text_en),
          feature_section_title_cn: text(h.feature_section_title_cn),
          feature_section_title_en: text(h.feature_section_title_en),
          feature_section_subtitle_cn: text(h.feature_section_subtitle_cn),
          feature_section_subtitle_en: text(h.feature_section_subtitle_en),
          category_section_title_cn: text(h.category_section_title_cn),
          category_section_title_en: text(h.category_section_title_en),
          category_section_subtitle_cn: text(h.category_section_subtitle_cn),
          category_section_subtitle_en: text(h.category_section_subtitle_en),
          featured_products_title_cn: text(h.featured_products_title_cn),
          featured_products_title_en: text(h.featured_products_title_en),
          featured_products_subtitle_cn: text(h.featured_products_subtitle_cn),
          featured_products_subtitle_en: text(h.featured_products_subtitle_en),
          certificates_section_title_cn: text(h.certificates_section_title_cn),
          certificates_section_title_en: text(h.certificates_section_title_en),
          certificates_note_cn: text(h.certificates_note_cn),
          certificates_note_en: text(h.certificates_note_en),
          projects_section_title_cn: text(h.projects_section_title_cn),
          projects_section_title_en: text(h.projects_section_title_en),
          projects_section_subtitle_cn: text(h.projects_section_subtitle_cn),
          projects_section_subtitle_en: text(h.projects_section_subtitle_en),
          bottom_cta_eyebrow_cn: text(h.bottom_cta_eyebrow_cn),
          bottom_cta_eyebrow_en: text(h.bottom_cta_eyebrow_en),
          bottom_cta_title_cn: text(h.bottom_cta_title_cn),
          bottom_cta_title_en: text(h.bottom_cta_title_en),
          bottom_cta_description_cn: text(h.bottom_cta_description_cn),
          bottom_cta_description_en: text(h.bottom_cta_description_en),
          bottom_cta_button_text_cn: text(h.bottom_cta_button_text_cn),
          bottom_cta_button_text_en: text(h.bottom_cta_button_text_en),
          is_active: h.is_active,
        });
        setHeroSlides(h.hero_slides || []);
        setFeaturesCn(h.features_cn || []);
        setFeaturesEn(h.features_en || []);
      } else if (!result.ok) {
        show(errorText(result.code), "error");
      }
      setLoading(false);
    })();
  }, [show]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  function updateSlide<K extends keyof HomeHeroSlide>(
    index: number,
    key: K,
    value: HomeHeroSlide[K],
  ) {
    setHeroSlides((previous) =>
      previous.map((slide, slideIndex) =>
        slideIndex === index ? { ...slide, [key]: value } : slide,
      ),
    );
  }

  function moveSlide(index: number, direction: -1 | 1) {
    setHeroSlides((previous) => {
      const target = index + direction;
      if (target < 0 || target >= previous.length) return previous;
      const next = [...previous];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function addSlide() {
    if (heroSlides.length >= 5) {
      show("最多配置 5 张轮播图", "error");
      return;
    }
    setHeroSlides((previous) => [...previous, createSlide()]);
  }

  function updateFeature(
    lang: "cn" | "en",
    index: number,
    field: keyof HomeFeatureItem,
    value: string,
  ) {
    const setter = lang === "cn" ? setFeaturesCn : setFeaturesEn;
    setter((previous) =>
      previous.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item,
      ),
    );
  }

  function addFeature(lang: "cn" | "en") {
    const setter = lang === "cn" ? setFeaturesCn : setFeaturesEn;
    setter((previous) => [
      ...previous,
      { icon: "flame", title: "", description: "" },
    ]);
  }

  function removeFeature(lang: "cn" | "en", index: number) {
    const setter = lang === "cn" ? setFeaturesCn : setFeaturesEn;
    setter((previous) => previous.filter((_, itemIndex) => itemIndex !== index));
  }

  function moveFeature(lang: "cn" | "en", index: number, direction: -1 | 1) {
    const setter = lang === "cn" ? setFeaturesCn : setFeaturesEn;
    setter((previous) => {
      const target = index + direction;
      if (target < 0 || target >= previous.length) return previous;
      const next = [...previous];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const invalidActiveSlide = heroSlides.some(
      (slide) => slide.enabled && !slide.desktop_image_url.trim(),
    );
    if (invalidActiveSlide) {
      show("启用的轮播图必须上传桌面端图片", "error");
      return;
    }

    setSaving(true);
    const payload = {
      ...Object.fromEntries(
        Object.entries(form)
          .filter(([key]) => key !== "is_active")
          .map(([key, value]) => [key, nullable(String(value))]),
      ),
      hero_slides: heroSlides,
      features_cn: featuresCn,
      features_en: featuresEn,
      is_active: form.is_active,
    };

    const result = await saveHomepageContentApi({
      id: contentId,
      expectedUpdatedAt: contentId ? contentUpdatedAt : null,
      payload,
    });
    setSaving(false);

    if (!result.ok) {
      show(errorText(result.code), "error");
      return;
    }
    if (!contentId && result.data.id) setContentId(result.data.id);
    if (result.data.updatedAt) setContentUpdatedAt(result.data.updatedAt);
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
          管理全屏 Hero 轮播、首页关键文案与核心优势，中英文分别生效
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Section
          title="Hero 轮播图"
          subtitle="最多 5 张；桌面图必填，手机竖图可选。未配置启用图片时自动使用网站默认 Hero 图。"
        >
          <div className="flex items-center justify-between rounded-lg border border-dashed border-gray-200 bg-gray-50 px-4 py-3">
            <div className="text-xs text-gray-500">
              当前 {heroSlides.length}/5 张，可排序、停用或删除
            </div>
            <button
              type="button"
              onClick={addSlide}
              disabled={heroSlides.length >= 5}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" /> 添加轮播图
            </button>
          </div>

          {heroSlides.length === 0 && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-5 py-8 text-center text-sm text-gray-400">
              暂无后台轮播图，前台将使用当前默认主图和下方默认文案
            </div>
          )}

          {heroSlides.map((slide, index) => (
            <div
              key={slide.id}
              className="space-y-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600">
                    轮播 {index + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => updateSlide(index, "enabled", !slide.enabled)}
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${
                      slide.enabled
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {slide.enabled ? (
                      <Eye className="h-3.5 w-3.5" />
                    ) : (
                      <EyeOff className="h-3.5 w-3.5" />
                    )}
                    {slide.enabled ? "已启用" : "已停用"}
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  <IconButton
                    label="上移"
                    disabled={index === 0}
                    onClick={() => moveSlide(index, -1)}
                  >
                    <ChevronUp className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    label="下移"
                    disabled={index === heroSlides.length - 1}
                    onClick={() => moveSlide(index, 1)}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    label="删除轮播图"
                    danger
                    onClick={() =>
                      setHeroSlides((previous) =>
                        previous.filter((_, slideIndex) => slideIndex !== index),
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>

              <div className="grid gap-5 lg:grid-cols-2">
                <ImageUpload
                  value={slide.desktop_image_url}
                  onChange={(value) =>
                    updateSlide(index, "desktop_image_url", value)
                  }
                  purpose="homepage-image"
                  label="桌面端主图"
                  hint="建议 1920×1080 或更宽，JPG/WebP，主体尽量靠右"
                  aspect="wide"
                />
                <ImageUpload
                  value={slide.mobile_image_url || ""}
                  onChange={(value) =>
                    updateSlide(index, "mobile_image_url", value || null)
                  }
                  purpose="homepage-image"
                  label="手机端竖图（可选）"
                  hint="建议 1080×1440；未上传时自动裁切桌面图"
                  aspect="wide"
                />
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Input
                  label="图片说明（中文）"
                  value={text(slide.alt_cn)}
                  onChange={(event) =>
                    updateSlide(index, "alt_cn", nullable(event.target.value))
                  }
                />
                <Input
                  label="图片说明（英文）"
                  value={text(slide.alt_en)}
                  onChange={(event) =>
                    updateSlide(index, "alt_en", nullable(event.target.value))
                  }
                />
                <Input
                  label="眉标（中文）"
                  value={text(slide.eyebrow_cn)}
                  onChange={(event) =>
                    updateSlide(index, "eyebrow_cn", nullable(event.target.value))
                  }
                />
                <Input
                  label="眉标（英文）"
                  value={text(slide.eyebrow_en)}
                  onChange={(event) =>
                    updateSlide(index, "eyebrow_en", nullable(event.target.value))
                  }
                />
                <Input
                  label="主标题（中文）"
                  value={text(slide.title_cn)}
                  onChange={(event) =>
                    updateSlide(index, "title_cn", nullable(event.target.value))
                  }
                  hint="留空时使用下方默认 Hero 文案"
                />
                <Input
                  label="主标题（英文）"
                  value={text(slide.title_en)}
                  onChange={(event) =>
                    updateSlide(index, "title_en", nullable(event.target.value))
                  }
                />
                <Input
                  label="第二行标题（中文）"
                  value={text(slide.highlight_cn)}
                  onChange={(event) =>
                    updateSlide(index, "highlight_cn", nullable(event.target.value))
                  }
                />
                <Input
                  label="第二行标题（英文）"
                  value={text(slide.highlight_en)}
                  onChange={(event) =>
                    updateSlide(index, "highlight_en", nullable(event.target.value))
                  }
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Textarea
                  label="描述（中文）"
                  rows={3}
                  value={text(slide.description_cn)}
                  onChange={(event) =>
                    updateSlide(index, "description_cn", nullable(event.target.value))
                  }
                />
                <Textarea
                  label="描述（英文）"
                  rows={3}
                  value={text(slide.description_en)}
                  onChange={(event) =>
                    updateSlide(index, "description_en", nullable(event.target.value))
                  }
                />
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                <Input
                  label="主按钮（中文）"
                  value={text(slide.primary_cta_text_cn)}
                  onChange={(event) =>
                    updateSlide(
                      index,
                      "primary_cta_text_cn",
                      nullable(event.target.value),
                    )
                  }
                />
                <Input
                  label="主按钮（英文）"
                  value={text(slide.primary_cta_text_en)}
                  onChange={(event) =>
                    updateSlide(
                      index,
                      "primary_cta_text_en",
                      nullable(event.target.value),
                    )
                  }
                />
                <Input
                  label="主按钮链接"
                  value={slide.primary_cta_href || "/products"}
                  onChange={(event) =>
                    updateSlide(index, "primary_cta_href", event.target.value)
                  }
                  hint="仅允许 / 开头站内路径或 #锚点"
                />
                <Input
                  label="次按钮（中文）"
                  value={text(slide.secondary_cta_text_cn)}
                  onChange={(event) =>
                    updateSlide(
                      index,
                      "secondary_cta_text_cn",
                      nullable(event.target.value),
                    )
                  }
                />
                <Input
                  label="次按钮（英文）"
                  value={text(slide.secondary_cta_text_en)}
                  onChange={(event) =>
                    updateSlide(
                      index,
                      "secondary_cta_text_en",
                      nullable(event.target.value),
                    )
                  }
                />
                <Input
                  label="次按钮链接"
                  value={slide.secondary_cta_href || "/contact"}
                  onChange={(event) =>
                    updateSlide(index, "secondary_cta_href", event.target.value)
                  }
                />
              </div>

              <div className="grid gap-4 rounded-lg bg-gray-50 p-4 md:grid-cols-3">
                <RangeField
                  label="横向焦点"
                  value={slide.focal_x}
                  min={0}
                  max={100}
                  suffix="%"
                  onChange={(value) => updateSlide(index, "focal_x", value)}
                />
                <RangeField
                  label="纵向焦点"
                  value={slide.focal_y}
                  min={0}
                  max={100}
                  suffix="%"
                  onChange={(value) => updateSlide(index, "focal_y", value)}
                />
                <RangeField
                  label="整体暗色遮罩"
                  value={Math.round(slide.overlay_opacity * 100)}
                  min={20}
                  max={82}
                  suffix="%"
                  onChange={(value) =>
                    updateSlide(index, "overlay_opacity", value / 100)
                  }
                />
              </div>
            </div>
          ))}
        </Section>

        <Section
          title="Hero 默认文案"
          subtitle="轮播单张文案留空时继承这里；未配置轮播图时也使用这里"
        >
          <BilingualInputs
            cnLabel="眉标（中文）"
            enLabel="眉标（英文）"
            cnValue={form.hero_eyebrow_cn}
            enValue={form.hero_eyebrow_en}
            onCn={(value) => update("hero_eyebrow_cn", value)}
            onEn={(value) => update("hero_eyebrow_en", value)}
          />
          <BilingualInputs
            cnLabel="主标题（中文）"
            enLabel="主标题（英文）"
            cnValue={form.hero_title_cn}
            enValue={form.hero_title_en}
            onCn={(value) => update("hero_title_cn", value)}
            onEn={(value) => update("hero_title_en", value)}
          />
          <BilingualInputs
            cnLabel="第二行标题（中文）"
            enLabel="第二行标题（英文）"
            cnValue={form.hero_highlight_cn}
            enValue={form.hero_highlight_en}
            onCn={(value) => update("hero_highlight_cn", value)}
            onEn={(value) => update("hero_highlight_en", value)}
          />
          <div className="grid gap-4 md:grid-cols-2">
            <Textarea
              label="描述（中文）"
              rows={3}
              value={form.hero_description_cn}
              onChange={(event) =>
                update("hero_description_cn", event.target.value)
              }
            />
            <Textarea
              label="描述（英文）"
              rows={3}
              value={form.hero_description_en}
              onChange={(event) =>
                update("hero_description_en", event.target.value)
              }
            />
          </div>
          <BilingualInputs
            cnLabel="主按钮文案（中文）"
            enLabel="主按钮文案（英文）"
            cnValue={form.primary_cta_text_cn}
            enValue={form.primary_cta_text_en}
            onCn={(value) => update("primary_cta_text_cn", value)}
            onEn={(value) => update("primary_cta_text_en", value)}
          />
          <BilingualInputs
            cnLabel="次按钮文案（中文）"
            enLabel="次按钮文案（英文）"
            cnValue={form.secondary_cta_text_cn}
            enValue={form.secondary_cta_text_en}
            onCn={(value) => update("secondary_cta_text_cn", value)}
            onEn={(value) => update("secondary_cta_text_en", value)}
          />
        </Section>

        <Section title="核心优势区块" subtitle="标题、副标题和优势卡片均支持中英文">
          <BilingualInputs
            cnLabel="区块标题（中文）"
            enLabel="区块标题（英文）"
            cnValue={form.feature_section_title_cn}
            enValue={form.feature_section_title_en}
            onCn={(value) => update("feature_section_title_cn", value)}
            onEn={(value) => update("feature_section_title_en", value)}
          />
          <BilingualInputs
            cnLabel="区块副标题（中文）"
            enLabel="区块副标题（英文）"
            cnValue={form.feature_section_subtitle_cn}
            enValue={form.feature_section_subtitle_en}
            onCn={(value) => update("feature_section_subtitle_cn", value)}
            onEn={(value) => update("feature_section_subtitle_en", value)}
          />
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

        <Section
          title="首页关键区块文案"
          subtitle="产品类目、主推产品、证书与案例区域的标题说明"
        >
          <CopyGroup title="产品类目">
            <BilingualInputs
              cnLabel="标题（中文）"
              enLabel="标题（英文）"
              cnValue={form.category_section_title_cn}
              enValue={form.category_section_title_en}
              onCn={(value) => update("category_section_title_cn", value)}
              onEn={(value) => update("category_section_title_en", value)}
            />
            <BilingualInputs
              cnLabel="副标题（中文）"
              enLabel="副标题（英文）"
              cnValue={form.category_section_subtitle_cn}
              enValue={form.category_section_subtitle_en}
              onCn={(value) => update("category_section_subtitle_cn", value)}
              onEn={(value) => update("category_section_subtitle_en", value)}
            />
          </CopyGroup>

          <CopyGroup title="主推产品">
            <BilingualInputs
              cnLabel="标题（中文）"
              enLabel="标题（英文）"
              cnValue={form.featured_products_title_cn}
              enValue={form.featured_products_title_en}
              onCn={(value) => update("featured_products_title_cn", value)}
              onEn={(value) => update("featured_products_title_en", value)}
            />
            <BilingualInputs
              cnLabel="副标题（中文）"
              enLabel="副标题（英文）"
              cnValue={form.featured_products_subtitle_cn}
              enValue={form.featured_products_subtitle_en}
              onCn={(value) => update("featured_products_subtitle_cn", value)}
              onEn={(value) => update("featured_products_subtitle_en", value)}
            />
          </CopyGroup>

          <CopyGroup title="证书展示">
            <BilingualInputs
              cnLabel="标题（中文）"
              enLabel="标题（英文）"
              cnValue={form.certificates_section_title_cn}
              enValue={form.certificates_section_title_en}
              onCn={(value) => update("certificates_section_title_cn", value)}
              onEn={(value) => update("certificates_section_title_en", value)}
            />
            <div className="grid gap-4 md:grid-cols-2">
              <Textarea
                label="说明（中文）"
                rows={2}
                value={form.certificates_note_cn}
                onChange={(event) =>
                  update("certificates_note_cn", event.target.value)
                }
              />
              <Textarea
                label="说明（英文）"
                rows={2}
                value={form.certificates_note_en}
                onChange={(event) =>
                  update("certificates_note_en", event.target.value)
                }
              />
            </div>
          </CopyGroup>

          <CopyGroup title="应用案例">
            <BilingualInputs
              cnLabel="标题（中文）"
              enLabel="标题（英文）"
              cnValue={form.projects_section_title_cn}
              enValue={form.projects_section_title_en}
              onCn={(value) => update("projects_section_title_cn", value)}
              onEn={(value) => update("projects_section_title_en", value)}
            />
            <BilingualInputs
              cnLabel="副标题（中文）"
              enLabel="副标题（英文）"
              cnValue={form.projects_section_subtitle_cn}
              enValue={form.projects_section_subtitle_en}
              onCn={(value) => update("projects_section_subtitle_cn", value)}
              onEn={(value) => update("projects_section_subtitle_en", value)}
            />
          </CopyGroup>
        </Section>

        <Section title="底部 CTA" subtitle="首页底部号召区域全部关键文案">
          <BilingualInputs
            cnLabel="眉标（中文）"
            enLabel="眉标（英文）"
            cnValue={form.bottom_cta_eyebrow_cn}
            enValue={form.bottom_cta_eyebrow_en}
            onCn={(value) => update("bottom_cta_eyebrow_cn", value)}
            onEn={(value) => update("bottom_cta_eyebrow_en", value)}
          />
          <BilingualInputs
            cnLabel="标题（中文）"
            enLabel="标题（英文）"
            cnValue={form.bottom_cta_title_cn}
            enValue={form.bottom_cta_title_en}
            onCn={(value) => update("bottom_cta_title_cn", value)}
            onEn={(value) => update("bottom_cta_title_en", value)}
          />
          <div className="grid gap-4 md:grid-cols-2">
            <Textarea
              label="描述（中文）"
              rows={2}
              value={form.bottom_cta_description_cn}
              onChange={(event) =>
                update("bottom_cta_description_cn", event.target.value)
              }
            />
            <Textarea
              label="描述（英文）"
              rows={2}
              value={form.bottom_cta_description_en}
              onChange={(event) =>
                update("bottom_cta_description_en", event.target.value)
              }
            />
          </div>
          <BilingualInputs
            cnLabel="按钮（中文）"
            enLabel="按钮（英文）"
            cnValue={form.bottom_cta_button_text_cn}
            enValue={form.bottom_cta_button_text_en}
            onCn={(value) => update("bottom_cta_button_text_cn", value)}
            onEn={(value) => update("bottom_cta_button_text_en", value)}
          />
        </Section>

        <Section title="发布状态" subtitle="控制这一版首页内容是否供前台读取">
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

function BilingualInputs({
  cnLabel,
  enLabel,
  cnValue,
  enValue,
  onCn,
  onEn,
}: {
  cnLabel: string;
  enLabel: string;
  cnValue: string;
  enValue: string;
  onCn: (value: string) => void;
  onEn: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Input
        label={cnLabel}
        value={cnValue}
        onChange={(event) => onCn(event.target.value)}
      />
      <Input
        label={enLabel}
        value={enValue}
        onChange={(event) => onEn(event.target.value)}
      />
    </div>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="space-y-2 text-xs text-gray-600">
      <span className="flex items-center justify-between">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-gray-400">
          {value}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-[#A98643]"
      />
    </label>
  );
}

function CopyGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4 rounded-xl border border-gray-100 bg-gray-50/70 p-4">
      <h3 className="text-xs font-semibold text-gray-600">{title}</h3>
      {children}
    </div>
  );
}

function IconButton({
  label,
  disabled,
  danger,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md p-1.5 disabled:opacity-30 ${
        danger
          ? "text-red-500 hover:bg-red-50"
          : "text-gray-500 hover:bg-gray-100"
      }`}
    >
      {children}
    </button>
  );
}

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
    index: number,
    field: keyof HomeFeatureItem,
    value: string,
  ) => void;
  onAdd: (lang: "cn" | "en") => void;
  onRemove: (lang: "cn" | "en", index: number) => void;
  onMove: (lang: "cn" | "en", index: number, direction: -1 | 1) => void;
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
      {items.map((item, index) => (
        <div
          key={`${lang}-${index}`}
          className="rounded-lg border border-gray-200 bg-gray-50 p-4"
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs text-gray-400">卡片 {index + 1}</span>
            <div className="flex items-center gap-1">
              <IconButton
                label="上移"
                disabled={index === 0}
                onClick={() => onMove(lang, index, -1)}
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton
                label="下移"
                disabled={index === items.length - 1}
                onClick={() => onMove(lang, index, 1)}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton
                label="删除"
                danger
                onClick={() => onRemove(lang, index)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          </div>
          <div className="space-y-3">
            <Input
              label="图标标识"
              value={item.icon}
              onChange={(event) =>
                onUpdate(lang, index, "icon", event.target.value)
              }
              hint="flame / leaf / truck / globe / shield"
            />
            <Input
              label="标题"
              value={item.title}
              onChange={(event) =>
                onUpdate(lang, index, "title", event.target.value)
              }
            />
            <Textarea
              label="描述"
              rows={2}
              value={item.description}
              onChange={(event) =>
                onUpdate(lang, index, "description", event.target.value)
              }
            />
          </div>
        </div>
      ))}
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
