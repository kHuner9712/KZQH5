"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { useToast } from "@/components/admin/Toast";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { ImageUpload } from "@/components/admin/ImageUpload";
import { generateSlug } from "@/lib/utils";
import type {
  Category,
  Subcategory,
  Product,
  ProductImage,
  ProductFaqItem,
} from "@/types/database";
import { Loader2, Plus, Trash2, Save, ChevronUp, ChevronDown } from "lucide-react";

interface ProductFormProps {
  initial?: Product | null;
  initialImages?: ProductImage[];
}

interface FormState {
  name_cn: string;
  name_en: string;
  slug: string;
  category_id: string;
  subcategory_id: string;
  summary_cn: string;
  summary_en: string;
  description_cn: string;
  description_en: string;
  material_cn: string;
  material_en: string;
  size: string;
  fire_rating: string;
  eco_grade: string;
  price_display_cn: string;
  price_display_en: string;
  moq: string;
  packaging_cn: string;
  packaging_en: string;
  logistics_cn: string;
  logistics_en: string;
  application_cn: string;
  application_en: string;
  video_url: string;
  cover_image_url: string;
  is_featured: boolean;
  is_published: boolean;
  sort_order: number;
  // ----- GEO / SEO 扩展字段（编辑态为字符串，保存时转换） -----
  seo_title_cn: string;
  seo_title_en: string;
  seo_description_cn: string;
  seo_description_en: string;
  geo_summary_cn: string;
  geo_summary_en: string;
  keywords_cn: string;
  keywords_en: string;
  search_aliases: string;
  schema_extra: string;
}

const defaultForm: FormState = {
  name_cn: "",
  name_en: "",
  slug: "",
  category_id: "",
  subcategory_id: "",
  summary_cn: "",
  summary_en: "",
  description_cn: "",
  description_en: "",
  material_cn: "",
  material_en: "",
  size: "",
  fire_rating: "B级",
  eco_grade: "E0级",
  price_display_cn: "请联系销售获取报价",
  price_display_en: "Contact for quotation",
  moq: "",
  packaging_cn: "",
  packaging_en: "",
  logistics_cn: "",
  logistics_en: "",
  application_cn: "",
  application_en: "",
  video_url: "",
  cover_image_url: "",
  is_featured: false,
  is_published: false,
  sort_order: 0,
  seo_title_cn: "",
  seo_title_en: "",
  seo_description_cn: "",
  seo_description_en: "",
  geo_summary_cn: "",
  geo_summary_en: "",
  keywords_cn: "",
  keywords_en: "",
  search_aliases: "",
  schema_extra: "",
};

export function ProductForm({ initial, initialImages = [] }: ProductFormProps) {
  const router = useRouter();
  const supabase = createBrowserSupabaseClient();
  const { show } = useToast();
  const isEdit = !!initial;

  const [form, setForm] = useState<FormState>(() =>
    initial
      ? {
          name_cn: initial.name_cn || "",
          name_en: initial.name_en || "",
          slug: initial.slug || "",
          category_id: initial.category_id || "",
          subcategory_id: initial.subcategory_id || "",
          summary_cn: initial.summary_cn || "",
          summary_en: initial.summary_en || "",
          description_cn: initial.description_cn || "",
          description_en: initial.description_en || "",
          material_cn: initial.material_cn || "",
          material_en: initial.material_en || "",
          size: initial.size || "",
          fire_rating: initial.fire_rating || "B级",
          eco_grade: initial.eco_grade || "E0级",
          price_display_cn: initial.price_display_cn || "",
          price_display_en: initial.price_display_en || "",
          moq: initial.moq || "",
          packaging_cn: initial.packaging_cn || "",
          packaging_en: initial.packaging_en || "",
          logistics_cn: initial.logistics_cn || "",
          logistics_en: initial.logistics_en || "",
          application_cn: initial.application_cn || "",
          application_en: initial.application_en || "",
          video_url: initial.video_url || "",
          cover_image_url: initial.cover_image_url || "",
          is_featured: initial.is_featured,
          is_published: initial.is_published,
          sort_order: initial.sort_order,
          seo_title_cn: initial.seo_title_cn || "",
          seo_title_en: initial.seo_title_en || "",
          seo_description_cn: initial.seo_description_cn || "",
          seo_description_en: initial.seo_description_en || "",
          geo_summary_cn: initial.geo_summary_cn || "",
          geo_summary_en: initial.geo_summary_en || "",
          keywords_cn: initial.keywords_cn?.join(", ") || "",
          keywords_en: initial.keywords_en?.join(", ") || "",
          search_aliases: initial.search_aliases?.join(", ") || "",
          schema_extra: initial.schema_extra
            ? JSON.stringify(initial.schema_extra, null, 2)
            : "",
        }
      : defaultForm
  );

  const [categories, setCategories] = useState<Category[]>([]);
  const [subcategories, setSubcategories] = useState<Subcategory[]>([]);
  const [images, setImages] = useState<ProductImage[]>(
    initialImages.length > 0
      ? initialImages.sort((a, b) => a.sort_order - b.sort_order)
      : []
  );
  const [newImageUrl, setNewImageUrl] = useState("");
  const [newImageAlt, setNewImageAlt] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [faqCn, setFaqCn] = useState<ProductFaqItem[]>(initial?.faq_cn || []);
  const [faqEn, setFaqEn] = useState<ProductFaqItem[]>(initial?.faq_en || []);

  // 加载类目
  useEffect(() => {
    (async () => {
      const { data: cats } = await supabase
        .from("categories")
        .select("*")
        .order("sort_order", { ascending: true });
      setCategories((cats as Category[] | null) || []);
      setLoadingMeta(false);
    })();
  }, [supabase]);

  // 加载二级类目
  useEffect(() => {
    if (!form.category_id) {
      setSubcategories([]);
      return;
    }
    (async () => {
      const { data: subs } = await supabase
        .from("subcategories")
        .select("*")
        .eq("category_id", form.category_id)
        .order("sort_order", { ascending: true });
      setSubcategories((subs as Subcategory[] | null) || []);
    })();
  }, [supabase, form.category_id]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((p) => ({ ...p, [key]: value }));
  }

  function validate() {
    const e: Record<string, string> = {};
    if (!form.name_cn.trim()) e.name_cn = "请输入产品中文名称";
    if (!form.slug.trim()) e.slug = "请输入 slug";
    if (!/^[a-z0-9-]+$/.test(form.slug)) e.slug = "slug 只能包含小写字母、数字和连字符";
    if (!form.category_id) e.category_id = "请选择一级类目";
    if (form.video_url && !/^https?:\/\//.test(form.video_url)) e.video_url = "视频 URL 需以 http(s):// 开头";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function addImage() {
    if (!newImageUrl.trim()) return;
    setImages((p) => [
      ...p,
      {
        id: `tmp-${Date.now()}`,
        product_id: initial?.id || "",
        image_url: newImageUrl.trim(),
        alt_cn: newImageAlt.trim() || null,
        alt_en: null,
        sort_order: p.length,
        created_at: new Date().toISOString(),
      },
    ]);
    setNewImageUrl("");
    setNewImageAlt("");
  }

  function removeImage(idx: number) {
    setImages((p) => p.filter((_, i) => i !== idx).map((img, i) => ({ ...img, sort_order: i })));
  }

  function moveImage(idx: number, dir: -1 | 1) {
    setImages((p) => {
      const next = [...p];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return p;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next.map((img, i) => ({ ...img, sort_order: i }));
    });
  }

  // FAQ 中文
  function addFaqCn() {
    setFaqCn((p) => [...p, { question: "", answer: "" }]);
  }
  function removeFaqCn(idx: number) {
    setFaqCn((p) => p.filter((_, i) => i !== idx));
  }
  function moveFaqCn(idx: number, dir: -1 | 1) {
    setFaqCn((p) => {
      const next = [...p];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return p;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }
  function updateFaqCn(idx: number, key: "question" | "answer", value: string) {
    setFaqCn((p) => p.map((it, i) => (i === idx ? { ...it, [key]: value } : it)));
  }

  // FAQ 英文
  function addFaqEn() {
    setFaqEn((p) => [...p, { question: "", answer: "" }]);
  }
  function removeFaqEn(idx: number) {
    setFaqEn((p) => p.filter((_, i) => i !== idx));
  }
  function moveFaqEn(idx: number, dir: -1 | 1) {
    setFaqEn((p) => {
      const next = [...p];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return p;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }
  function updateFaqEn(idx: number, key: "question" | "answer", value: string) {
    setFaqEn((p) => p.map((it, i) => (i === idx ? { ...it, [key]: value } : it)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) {
      show("请检查表单必填项", "error");
      return;
    }

    // 解析 schema_extra JSON（可选）
    let schemaExtra: Record<string, unknown> | null = null;
    if (form.schema_extra.trim()) {
      try {
        const parsed = JSON.parse(form.schema_extra);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          schemaExtra = parsed as Record<string, unknown>;
        } else {
          show("schema_extra 必须是 JSON 对象", "error");
          return;
        }
      } catch {
        show("schema_extra JSON 格式错误", "error");
        return;
      }
    }

    // 转换 FAQ：过滤空项，空数组保存为 null
    const faqCnFiltered = faqCn.filter(
      (f) => f.question.trim() && f.answer.trim()
    );
    const faqEnFiltered = faqEn.filter(
      (f) => f.question.trim() && f.answer.trim()
    );

    setSaving(true);

    const payload = {
      name_cn: form.name_cn.trim(),
      name_en: form.name_en.trim() || null,
      slug: form.slug.trim(),
      category_id: form.category_id || null,
      subcategory_id: form.subcategory_id || null,
      summary_cn: form.summary_cn.trim() || null,
      summary_en: form.summary_en.trim() || null,
      description_cn: form.description_cn.trim() || null,
      description_en: form.description_en.trim() || null,
      material_cn: form.material_cn.trim() || null,
      material_en: form.material_en.trim() || null,
      size: form.size.trim() || null,
      fire_rating: form.fire_rating || "B级",
      eco_grade: form.eco_grade || "E0级",
      price_display_cn: form.price_display_cn.trim() || null,
      price_display_en: form.price_display_en.trim() || null,
      moq: form.moq.trim() || null,
      packaging_cn: form.packaging_cn.trim() || null,
      packaging_en: form.packaging_en.trim() || null,
      logistics_cn: form.logistics_cn.trim() || null,
      logistics_en: form.logistics_en.trim() || null,
      application_cn: form.application_cn.trim() || null,
      application_en: form.application_en.trim() || null,
      video_url: form.video_url.trim() || null,
      cover_image_url: form.cover_image_url || null,
      is_featured: form.is_featured,
      is_published: form.is_published,
      sort_order: Number(form.sort_order) || 0,
      // ----- GEO / SEO -----
      seo_title_cn: form.seo_title_cn.trim() || null,
      seo_title_en: form.seo_title_en.trim() || null,
      seo_description_cn: form.seo_description_cn.trim() || null,
      seo_description_en: form.seo_description_en.trim() || null,
      geo_summary_cn: form.geo_summary_cn.trim() || null,
      geo_summary_en: form.geo_summary_en.trim() || null,
      keywords_cn: form.keywords_cn.trim()
        ? form.keywords_cn
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : null,
      keywords_en: form.keywords_en.trim()
        ? form.keywords_en
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : null,
      search_aliases: form.search_aliases.trim()
        ? form.search_aliases
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : null,
      schema_extra: schemaExtra,
      faq_cn: faqCnFiltered.length > 0 ? faqCnFiltered : null,
      faq_en: faqEnFiltered.length > 0 ? faqEnFiltered : null,
    };

    let productId = initial?.id;

    if (isEdit && productId) {
      const { error } = await supabase.from("products").update(payload).eq("id", productId);
      if (error) {
        setSaving(false);
        show(error.message, "error");
        return;
      }
    } else {
      const { data: created, error } = await supabase
        .from("products")
        .insert(payload)
        .select("id")
        .single();
      if (error || !created) {
        setSaving(false);
        show(error?.message || "创建失败", "error");
        return;
      }
      productId = (created as { id: string }).id;
    }

    // 同步产品图片：先删旧、再插新（简单可靠）
    if (productId) {
      await supabase.from("product_images").delete().eq("product_id", productId);
      if (images.length > 0) {
        const imgPayload = images.map((img, i) => ({
          product_id: productId,
          image_url: img.image_url,
          alt_cn: img.alt_cn || null,
          alt_en: img.alt_en || null,
          sort_order: i,
        }));
        const { error: imgError } = await supabase.from("product_images").insert(imgPayload);
        if (imgError) {
          show(`图片保存失败：${imgError.message}`, "error");
        }
      }
    }

    setSaving(false);
    show(isEdit ? "产品已更新" : "产品已创建", "success");
    setTimeout(() => router.push("/admin/products"), 600);
  }

  if (loadingMeta) {
    return (
      <div className="flex h-40 items-center justify-center text-gray-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* 基本信息 */}
      <Section title="基本信息" subtitle="产品名称、slug 与类目归属">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Input
            label="中文名称"
            required
            value={form.name_cn}
            onChange={(e) => {
              update("name_cn", e.target.value);
              if (!isEdit) update("slug", generateSlug(e.target.value));
            }}
            error={errors.name_cn}
          />
          <Input
            label="英文名称"
            value={form.name_en}
            onChange={(e) => update("name_en", e.target.value)}
          />
          <Input
            label="Slug"
            required
            value={form.slug}
            onChange={(e) => update("slug", e.target.value)}
            error={errors.slug}
            hint="URL 标识，例如 kzq-fireproof-board-1220"
          />
          <Input
            label="排序"
            type="number"
            value={String(form.sort_order)}
            onChange={(e) => update("sort_order", Number(e.target.value))}
          />
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-700">
              一级类目<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              value={form.category_id}
              onChange={(e) => update("category_id", e.target.value)}
              className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-graphite outline-none focus:border-steel focus:ring-2 focus:ring-steel/20"
            >
              <option value="">请选择</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name_cn} {c.name_en ? `/ ${c.name_en}` : ""}
                </option>
              ))}
            </select>
            {errors.category_id && <p className="text-xs text-red-500">{errors.category_id}</p>}
          </div>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-700">二级类目</label>
            <select
              value={form.subcategory_id}
              onChange={(e) => update("subcategory_id", e.target.value)}
              disabled={!form.category_id}
              className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-graphite outline-none focus:border-steel focus:ring-2 focus:ring-steel/20 disabled:bg-gray-50"
            >
              <option value="">请选择</option>
              {subcategories.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name_cn} {s.name_en ? `/ ${s.name_en}` : ""}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <Toggle
            label="主推产品"
            checked={form.is_featured}
            onChange={(v) => update("is_featured", v)}
          />
          <Toggle
            label="前台发布"
            checked={form.is_published}
            onChange={(v) => update("is_published", v)}
            hint="关闭后前台不展示"
          />
        </div>
      </Section>

      {/* 产品描述 */}
      <Section title="产品描述" subtitle="中英文摘要与详细描述">
        <Input
          label="中文摘要"
          value={form.summary_cn}
          onChange={(e) => update("summary_cn", e.target.value)}
          hint="一句话概括，用于列表与 SEO description"
        />
        <Input
          label="英文摘要"
          value={form.summary_en}
          onChange={(e) => update("summary_en", e.target.value)}
        />
        <Textarea
          label="中文详细描述"
          rows={4}
          value={form.description_cn}
          onChange={(e) => update("description_cn", e.target.value)}
        />
        <Textarea
          label="英文详细描述"
          rows={4}
          value={form.description_en}
          onChange={(e) => update("description_en", e.target.value)}
        />
      </Section>

      {/* 规格参数 */}
      <Section title="规格参数" subtitle="尺寸、材质、防火、环保、MOQ、价格">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Input
            label="尺寸规格"
            value={form.size}
            onChange={(e) => update("size", e.target.value)}
            placeholder="例：1220×2440×9mm"
          />
          <Input
            label="MOQ 最小起订量"
            value={form.moq}
            onChange={(e) => update("moq", e.target.value)}
            placeholder="例：100 张"
          />
          <Input
            label="防火等级"
            value={form.fire_rating}
            onChange={(e) => update("fire_rating", e.target.value)}
            hint="默认 B级"
          />
          <Input
            label="环保等级"
            value={form.eco_grade}
            onChange={(e) => update("eco_grade", e.target.value)}
            hint="默认 E0级"
          />
          <Input
            label="中文材质说明"
            value={form.material_cn}
            onChange={(e) => update("material_cn", e.target.value)}
          />
          <Input
            label="英文材质说明"
            value={form.material_en}
            onChange={(e) => update("material_en", e.target.value)}
          />
          <Input
            label="中文价格展示"
            value={form.price_display_cn}
            onChange={(e) => update("price_display_cn", e.target.value)}
            hint="请填写对外展示价，禁止填写底价"
          />
          <Input
            label="英文价格展示"
            value={form.price_display_en}
            onChange={(e) => update("price_display_en", e.target.value)}
          />
        </div>
      </Section>

      {/* 包装物流应用 */}
      <Section title="包装 · 物流 · 应用" subtitle="交付与场景说明">
        <Textarea
          label="中文包装说明"
          rows={2}
          value={form.packaging_cn}
          onChange={(e) => update("packaging_cn", e.target.value)}
        />
        <Textarea
          label="英文包装说明"
          rows={2}
          value={form.packaging_en}
          onChange={(e) => update("packaging_en", e.target.value)}
        />
        <Textarea
          label="中文物流说明"
          rows={2}
          value={form.logistics_cn}
          onChange={(e) => update("logistics_cn", e.target.value)}
        />
        <Textarea
          label="英文物流说明"
          rows={2}
          value={form.logistics_en}
          onChange={(e) => update("logistics_en", e.target.value)}
        />
        <Textarea
          label="中文应用场景"
          rows={2}
          value={form.application_cn}
          onChange={(e) => update("application_cn", e.target.value)}
        />
        <Textarea
          label="英文应用场景"
          rows={2}
          value={form.application_en}
          onChange={(e) => update("application_en", e.target.value)}
        />
      </Section>

      {/* GEO / SEO */}
      <Section title="GEO / SEO 内容" subtitle="搜索引擎优化、地理化摘要与 FAQ">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Input
            label="SEO 标题（中）"
            value={form.seo_title_cn}
            onChange={(e) => update("seo_title_cn", e.target.value)}
          />
          <Input
            label="SEO 标题（英）"
            value={form.seo_title_en}
            onChange={(e) => update("seo_title_en", e.target.value)}
          />
        </div>
        <Textarea
          label="SEO 描述（中）"
          rows={2}
          value={form.seo_description_cn}
          onChange={(e) => update("seo_description_cn", e.target.value)}
        />
        <Textarea
          label="SEO 描述（英）"
          rows={2}
          value={form.seo_description_en}
          onChange={(e) => update("seo_description_en", e.target.value)}
        />
        <Textarea
          label="地理化摘要（中）"
          rows={3}
          value={form.geo_summary_cn}
          onChange={(e) => update("geo_summary_cn", e.target.value)}
        />
        <Textarea
          label="地理化摘要（英）"
          rows={3}
          value={form.geo_summary_en}
          onChange={(e) => update("geo_summary_en", e.target.value)}
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Input
            label="关键词（中）"
            value={form.keywords_cn}
            onChange={(e) => update("keywords_cn", e.target.value)}
            hint="多个关键词用英文逗号分隔"
          />
          <Input
            label="关键词（英）"
            value={form.keywords_en}
            onChange={(e) => update("keywords_en", e.target.value)}
            hint="多个关键词用英文逗号分隔"
          />
        </div>
        <Input
          label="搜索别名"
          value={form.search_aliases}
          onChange={(e) => update("search_aliases", e.target.value)}
          hint="搜索别名，逗号分隔"
        />
        <Textarea
          label="额外结构化数据 (JSON-LD)"
          rows={3}
          value={form.schema_extra}
          onChange={(e) => update("schema_extra", e.target.value)}
          hint="可选，额外 JSON-LD 结构化数据（JSON 对象）"
          placeholder='{"@context":"https://schema.org","@type":"Product"}'
        />

        <FaqEditor
          title="FAQ（中文）"
          items={faqCn}
          onAdd={addFaqCn}
          onRemove={removeFaqCn}
          onMove={moveFaqCn}
          onUpdate={updateFaqCn}
        />
        <FaqEditor
          title="FAQ（英文）"
          items={faqEn}
          onAdd={addFaqEn}
          onRemove={removeFaqEn}
          onMove={moveFaqEn}
          onUpdate={updateFaqEn}
        />
      </Section>

      {/* 媒体 */}
      <Section title="媒体资源" subtitle="封面图、视频 URL、详情图片">
        <ImageUpload
          label="封面图"
          folder="products/covers"
          value={form.cover_image_url}
          onChange={(url) => update("cover_image_url", url)}
          aspect="wide"
          hint="建议 16:9 横图，用于产品列表与分享卡片"
        />
        <Input
          label="产品视频 URL"
          value={form.video_url}
          onChange={(e) => update("video_url", e.target.value)}
          error={errors.video_url}
          placeholder="https://www.youtube.com/watch?v=xxx 或直链 mp4"
        />

        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700">详情图片（可拖动排序）</label>
          {images.length > 0 && (
            <div className="space-y-2">
              {images.map((img, idx) => (
                <div
                  key={img.id || idx}
                  className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-2"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.image_url || undefined}
                    alt={img.alt_cn || `图片 ${idx + 1}`}
                    className="h-14 w-20 rounded object-cover"
                  />
                  <input
                    type="text"
                    value={img.alt_cn || ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setImages((p) =>
                        p.map((it, i) => (i === idx ? { ...it, alt_cn: v } : it))
                      );
                    }}
                    placeholder="图片 alt 文案（中文）"
                    className="h-9 flex-1 rounded-md border border-gray-200 bg-white px-2.5 text-xs outline-none focus:border-steel"
                  />
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveImage(idx, -1)}
                      disabled={idx === 0}
                      className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                      aria-label="上移"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveImage(idx, 1)}
                      disabled={idx === images.length - 1}
                      className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                      aria-label="下移"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => removeImage(idx)}
                      className="rounded p-1 text-red-500 hover:bg-red-50"
                      aria-label="删除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="text"
                value={newImageUrl}
                onChange={(e) => setNewImageUrl(e.target.value)}
                placeholder="粘贴图片 URL 或上传后填入"
                className="h-9 flex-1 rounded-md border border-gray-200 bg-white px-2.5 text-xs outline-none focus:border-steel"
              />
              <input
                type="text"
                value={newImageAlt}
                onChange={(e) => setNewImageAlt(e.target.value)}
                placeholder="alt（可选）"
                className="h-9 flex-1 rounded-md border border-gray-200 bg-white px-2.5 text-xs outline-none focus:border-steel"
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={addImage}
                disabled={!newImageUrl.trim()}
              >
                <Plus className="h-3.5 w-3.5" /> 添加
              </Button>
            </div>
            <p className="mt-2 text-xs text-gray-400">
              建议通过上传按钮把图片上传到 public-assets 后，将返回的 URL 粘贴到这里
            </p>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <p className="mb-2 text-xs text-gray-500">或直接上传一张图片到详情图集：</p>
            <ImageUploadHelper
              onUploaded={(url) => {
                setImages((p) => [
                  ...p,
                  {
                    id: `tmp-${Date.now()}`,
                    product_id: initial?.id || "",
                    image_url: url,
                    alt_cn: null,
                    alt_en: null,
                    sort_order: p.length,
                    created_at: new Date().toISOString(),
                  },
                ]);
              }}
            />
          </div>
        </div>
      </Section>

      {/* 提交 */}
      <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-2 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:px-5">
        <Button type="button" variant="secondary" onClick={() => router.back()} disabled={saving}>
          取消
        </Button>
        <Button type="submit" loading={saving} disabled={saving}>
          <Save className="h-4 w-4" /> {isEdit ? "保存修改" : "创建产品"}
        </Button>
      </div>
    </form>
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

// ============================================================
// 子组件：开关
// ============================================================
function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex h-11 items-center justify-between rounded-lg border px-4 text-sm transition ${
        checked
          ? "border-emerald-300 bg-emerald-50 text-emerald-700"
          : "border-gray-200 bg-white text-gray-500"
      }`}
    >
      <div className="text-left">
        <div>{label}</div>
        {hint && <div className="text-[10px] text-gray-400">{hint}</div>}
      </div>
      <span
        className={`relative h-5 w-9 rounded-full transition ${
          checked ? "bg-emerald-500" : "bg-gray-300"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${
            checked ? "left-[1.125rem]" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

// ============================================================
// 辅助：直接上传图片到详情图集
// ============================================================
function ImageUploadHelper({ onUploaded }: { onUploaded: (url: string) => void }) {
  return (
    <ImageUpload
      folder="products/gallery"
      value=""
      onChange={(url) => {
        if (url) onUploaded(url);
      }}
      aspect="wide"
      label="上传图片到图集"
    />
  );
}

// ============================================================
// 子组件：FAQ 编辑器（中/英复用）
// ============================================================
function FaqEditor({
  title,
  items,
  onAdd,
  onRemove,
  onMove,
  onUpdate,
}: {
  title: string;
  items: ProductFaqItem[];
  onAdd: () => void;
  onRemove: (idx: number) => void;
  onMove: (idx: number, dir: -1 | 1) => void;
  onUpdate: (idx: number, key: "question" | "answer", value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-gray-700">{title}</label>
        <Button type="button" size="sm" variant="secondary" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" /> 添加 FAQ
        </Button>
      </div>
      {items.length > 0 && (
        <div className="space-y-2">
          {items.map((item, idx) => (
            <div
              key={idx}
              className="space-y-2 rounded-lg border border-gray-200 bg-white p-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">FAQ {idx + 1}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onMove(idx, -1)}
                    disabled={idx === 0}
                    className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                    aria-label="上移"
                  >
                    <ChevronUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onMove(idx, 1)}
                    disabled={idx === items.length - 1}
                    className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                    aria-label="下移"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(idx)}
                    className="rounded p-1 text-red-500 hover:bg-red-50"
                    aria-label="删除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <Input
                value={item.question}
                onChange={(e) => onUpdate(idx, "question", e.target.value)}
                placeholder="问题"
              />
              <Textarea
                rows={2}
                value={item.answer}
                onChange={(e) => onUpdate(idx, "answer", e.target.value)}
                placeholder="答案"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
