"use client";

import { useCallback, useEffect, useState } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { useToast } from "@/components/admin/Toast";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import type { PageContent, PageSection } from "@/types/database";
import {
  Loader2,
  Plus,
  Trash2,
  Save,
  ChevronUp,
  ChevronDown,
  Pencil,
  ArrowLeft,
} from "lucide-react";

const STANDARD_PAGE_KEYS = ["about", "certificates", "contact", "products"];

const PAGE_KEY_LABELS: Record<string, string> = {
  about: "关于我们",
  certificates: "证书资质",
  contact: "联系我们",
  products: "产品中心",
};

// 区块编辑单元：PageSection + items 多行文本（每行一项）
interface SectionEdit {
  section: PageSection;
  itemsText: string;
}

function toSectionEdits(sections: PageSection[] | null): SectionEdit[] {
  if (!sections) return [];
  return sections.map((s) => ({
    section: { ...s },
    itemsText: (s.items || []).join("\n"),
  }));
}

function sectionEditsToPayload(edits: SectionEdit[]): PageSection[] {
  return edits.map((e) => ({
    title: e.section.title?.trim() || undefined,
    subtitle: e.section.subtitle?.trim() || undefined,
    body: e.section.body?.trim() || undefined,
    icon: e.section.icon?.trim() || undefined,
    items: e.itemsText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  }));
}

export default function PagesPage() {
  const supabase = createBrowserSupabaseClient();
  const { show } = useToast();

  const [list, setList] = useState<PageContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PageContent | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("page_content")
      .select("*")
      .order("page_key", { ascending: true });
    setList((data as PageContent[] | null) || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const existingKeys = new Set(list.map((p) => p.page_key));
  const missingKeys = STANDARD_PAGE_KEYS.filter((k) => !existingKeys.has(k));

  async function createBlank(pageKey: string) {
    const { data, error } = await supabase
      .from("page_content")
      .insert({ page_key: pageKey })
      .select("*")
      .single();
    if (error || !data) {
      show(error?.message || "创建失败", "error");
      return;
    }
    show(`已创建页面：${pageKey}`, "success");
    await load();
    setSelected(data as PageContent);
  }

  async function handleSaved() {
    await load();
  }

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center text-gray-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (selected) {
    return (
      <PageEditor
        initial={selected}
        onClose={() => setSelected(null)}
        onSaved={handleSaved}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-graphite">页面内容</h1>
        <p className="mt-1 text-sm text-gray-500">
          管理关于、证书、联系、产品页的标题、描述、SEO 与区块
        </p>
      </div>

      {list.length === 0 && missingKeys.length === 0 ? (
        <div className="rounded-2xl bg-white p-10 text-center text-sm text-gray-400 ring-1 ring-gray-100">
          暂无页面
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-sm ring-1 ring-gray-100 sm:p-5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-steel/10 px-2 py-0.5 text-xs font-medium text-steel">
                    {p.page_key}
                  </span>
                  <span className="text-sm font-semibold text-graphite">
                    {p.title_cn || PAGE_KEY_LABELS[p.page_key] || p.page_key}
                  </span>
                </div>
                {p.updated_at && (
                  <p className="mt-1 text-xs text-gray-400">
                    更新于 {new Date(p.updated_at).toLocaleString("zh-CN")}
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setSelected(p)}
              >
                <Pencil className="h-3.5 w-3.5" /> 编辑
              </Button>
            </div>
          ))}

          {missingKeys.length > 0 && (
            <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 p-4">
              <p className="mb-3 text-xs text-gray-500">
                以下标准页面尚未创建，点击创建即可初始化空页面：
              </p>
              <div className="flex flex-wrap gap-2">
                {missingKeys.map((k) => (
                  <button
                    key={k}
                    onClick={() => createBlank(k)}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-steel hover:bg-steel/10"
                  >
                    <Plus className="h-3.5 w-3.5" /> 创建 {k}
                    {PAGE_KEY_LABELS[k] ? `（${PAGE_KEY_LABELS[k]}）` : ""}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 子组件：页面编辑器
// ============================================================
interface EditorForm {
  title_cn: string;
  title_en: string;
  subtitle_cn: string;
  subtitle_en: string;
  description_cn: string;
  description_en: string;
  seo_title_cn: string;
  seo_title_en: string;
  seo_description_cn: string;
  seo_description_en: string;
}

function PageEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: PageContent;
  onClose: () => void;
  onSaved: () => void;
}) {
  const supabase = createBrowserSupabaseClient();
  const { show } = useToast();

  const [form, setForm] = useState<EditorForm>({
    title_cn: initial.title_cn || "",
    title_en: initial.title_en || "",
    subtitle_cn: initial.subtitle_cn || "",
    subtitle_en: initial.subtitle_en || "",
    description_cn: initial.description_cn || "",
    description_en: initial.description_en || "",
    seo_title_cn: initial.seo_title_cn || "",
    seo_title_en: initial.seo_title_en || "",
    seo_description_cn: initial.seo_description_cn || "",
    seo_description_en: initial.seo_description_en || "",
  });
  const [sectionsCn, setSectionsCn] = useState<SectionEdit[]>(() =>
    toSectionEdits(initial.sections_cn)
  );
  const [sectionsEn, setSectionsEn] = useState<SectionEdit[]>(() =>
    toSectionEdits(initial.sections_en)
  );
  const [saving, setSaving] = useState(false);

  function update<K extends keyof EditorForm>(key: K, value: EditorForm[K]) {
    setForm((p) => ({ ...p, [key]: value }));
  }

  // ===== sections 编辑 =====
  function updateSectionField(
    lang: "cn" | "en",
    idx: number,
    field: keyof PageSection,
    value: string
  ) {
    const setter = lang === "cn" ? setSectionsCn : setSectionsEn;
    setter((prev) =>
      prev.map((it, i) =>
        i === idx ? { ...it, section: { ...it.section, [field]: value } } : it
      )
    );
  }

  function updateSectionItems(
    lang: "cn" | "en",
    idx: number,
    value: string
  ) {
    const setter = lang === "cn" ? setSectionsCn : setSectionsEn;
    setter((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, itemsText: value } : it))
    );
  }

  function addSection(lang: "cn" | "en") {
    const setter = lang === "cn" ? setSectionsCn : setSectionsEn;
    setter((prev) => [
      ...prev,
      { section: { title: "", subtitle: "", body: "", icon: "" }, itemsText: "" },
    ]);
  }

  function removeSection(lang: "cn" | "en", idx: number) {
    const setter = lang === "cn" ? setSectionsCn : setSectionsEn;
    setter((prev) => prev.filter((_, i) => i !== idx));
  }

  function moveSection(lang: "cn" | "en", idx: number, dir: -1 | 1) {
    const setter = lang === "cn" ? setSectionsCn : setSectionsEn;
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
      title_cn: form.title_cn.trim() || null,
      title_en: form.title_en.trim() || null,
      subtitle_cn: form.subtitle_cn.trim() || null,
      subtitle_en: form.subtitle_en.trim() || null,
      description_cn: form.description_cn.trim() || null,
      description_en: form.description_en.trim() || null,
      seo_title_cn: form.seo_title_cn.trim() || null,
      seo_title_en: form.seo_title_en.trim() || null,
      seo_description_cn: form.seo_description_cn.trim() || null,
      seo_description_en: form.seo_description_en.trim() || null,
      sections_cn: sectionEditsToPayload(sectionsCn),
      sections_en: sectionEditsToPayload(sectionsEn),
    };

    const { error } = await supabase
      .from("page_content")
      .update(payload)
      .eq("id", initial.id);

    setSaving(false);
    if (error) {
      show(error.message, "error");
      return;
    }
    show("页面内容已保存", "success");
    onSaved();
    onClose();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
          aria-label="返回"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-steel/10 px-2 py-0.5 text-xs font-medium text-steel">
              {initial.page_key}
            </span>
            <h1 className="text-xl font-bold text-graphite">
              编辑页面：{form.title_cn || initial.page_key}
            </h1>
          </div>
          <p className="mt-1 text-sm text-gray-500">
            标题、描述、SEO 与区块内容（中英文双语）
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Section title="页面基本信息" subtitle="标题、副标题与描述">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              label="标题（中文）"
              value={form.title_cn}
              onChange={(e) => update("title_cn", e.target.value)}
            />
            <Input
              label="标题（英文）"
              value={form.title_en}
              onChange={(e) => update("title_en", e.target.value)}
            />
            <Input
              label="副标题（中文）"
              value={form.subtitle_cn}
              onChange={(e) => update("subtitle_cn", e.target.value)}
            />
            <Input
              label="副标题（英文）"
              value={form.subtitle_en}
              onChange={(e) => update("subtitle_en", e.target.value)}
            />
          </div>
          <Textarea
            label="描述（中文）"
            rows={3}
            value={form.description_cn}
            onChange={(e) => update("description_cn", e.target.value)}
          />
          <Textarea
            label="描述（英文）"
            rows={3}
            value={form.description_en}
            onChange={(e) => update("description_en", e.target.value)}
          />
        </Section>

        <Section title="SEO 信息" subtitle="页面级 SEO title / description">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              label="SEO Title（中文）"
              value={form.seo_title_cn}
              onChange={(e) => update("seo_title_cn", e.target.value)}
            />
            <Input
              label="SEO Title（英文）"
              value={form.seo_title_en}
              onChange={(e) => update("seo_title_en", e.target.value)}
            />
          </div>
          <Textarea
            label="SEO Description（中文）"
            rows={2}
            value={form.seo_description_cn}
            onChange={(e) => update("seo_description_cn", e.target.value)}
          />
          <Textarea
            label="SEO Description（英文）"
            rows={2}
            value={form.seo_description_en}
            onChange={(e) => update("seo_description_en", e.target.value)}
          />
        </Section>

        <Section title="页面区块" subtitle="标题 / 描述 / 列表项，中英文双语维护">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <SectionListEditor
              lang="cn"
              title="中文区块"
              edits={sectionsCn}
              onUpdateField={updateSectionField}
              onUpdateItems={updateSectionItems}
              onAdd={addSection}
              onRemove={removeSection}
              onMove={moveSection}
            />
            <SectionListEditor
              lang="en"
              title="英文区块"
              edits={sectionsEn}
              onUpdateField={updateSectionField}
              onUpdateItems={updateSectionItems}
              onAdd={addSection}
              onRemove={removeSection}
              onMove={moveSection}
            />
          </div>
        </Section>

        <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-2 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:px-5">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button type="submit" loading={saving} disabled={saving}>
            <Save className="h-4 w-4" /> 保存页面
          </Button>
        </div>
      </form>
    </div>
  );
}

// ============================================================
// 子组件：区块列表编辑器
// ============================================================
function SectionListEditor({
  lang,
  title,
  edits,
  onUpdateField,
  onUpdateItems,
  onAdd,
  onRemove,
  onMove,
}: {
  lang: "cn" | "en";
  title: string;
  edits: SectionEdit[];
  onUpdateField: (
    lang: "cn" | "en",
    idx: number,
    field: keyof PageSection,
    value: string
  ) => void;
  onUpdateItems: (lang: "cn" | "en", idx: number, value: string) => void;
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
          <Plus className="h-3 w-3" /> 添加区块
        </button>
      </div>
      {edits.length === 0 && (
        <p className="text-xs text-gray-400">暂无区块</p>
      )}
      {edits.map((edit, idx) => (
        <div
          key={idx}
          className="rounded-lg border border-gray-200 bg-gray-50 p-4"
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs text-gray-400">区块 {idx + 1}</span>
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
                disabled={idx === edits.length - 1}
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input
                label="标题"
                value={edit.section.title || ""}
                onChange={(e) => onUpdateField(lang, idx, "title", e.target.value)}
              />
              <Input
                label="副标题"
                value={edit.section.subtitle || ""}
                onChange={(e) => onUpdateField(lang, idx, "subtitle", e.target.value)}
              />
            </div>
            <Input
              label="图标标识（可选）"
              value={edit.section.icon || ""}
              onChange={(e) => onUpdateField(lang, idx, "icon", e.target.value)}
              hint="可选，例如 shield / factory / truck"
            />
            <Textarea
              label="正文"
              rows={3}
              value={edit.section.body || ""}
              onChange={(e) => onUpdateField(lang, idx, "body", e.target.value)}
            />
            <Textarea
              label="列表项（每行一项）"
              rows={3}
              value={edit.itemsText}
              onChange={(e) => onUpdateItems(lang, idx, e.target.value)}
              hint="每行一条，保存时会自动去除空行"
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
