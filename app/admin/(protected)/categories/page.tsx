"use client";

import { useEffect, useState, useCallback } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { useToast } from "@/components/admin/Toast";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { Modal, FormActions } from "@/components/admin/Modal";
import { generateSlug } from "@/lib/utils";
import type { Category, Subcategory } from "@/types/database";
import {
  Plus,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  Loader2,
  GripVertical,
} from "lucide-react";

export default function CategoriesPage() {
  const supabase = createBrowserSupabaseClient();
  const { show } = useToast();

  const [categories, setCategories] = useState<Category[]>([]);
  const [subMap, setSubMap] = useState<Record<string, Subcategory[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [catModal, setCatModal] = useState<Category | null | "new">(null);
  const [subModal, setSubModal] = useState<{
    category: Category;
    sub: Subcategory | null;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: cats } = await supabase
      .from("categories")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    const catList = (cats as Category[] | null) || [];
    setCategories(catList);

    if (catList.length > 0) {
      const { data: subs } = await supabase
        .from("subcategories")
        .select("*")
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      const map: Record<string, Subcategory[]> = {};
      ((subs as Subcategory[] | null) || []).forEach((s) => {
        if (!map[s.category_id]) map[s.category_id] = [];
        map[s.category_id].push(s);
      });
      setSubMap(map);
      // 默认全展开
      const exp: Record<string, boolean> = {};
      catList.forEach((c) => (exp[c.id] = true));
      setExpanded(exp);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleActive(table: "categories" | "subcategories", id: string, value: boolean) {
    const { error } = await supabase.from(table).update({ is_active: !value }).eq("id", id);
    if (error) {
      show(error.message, "error");
      return;
    }
    show(value ? "已停用" : "已启用", "success");
    load();
  }

  async function deleteCategory(cat: Category) {
    if (!confirm(`确定删除一级类目「${cat.name_cn}」？\n该类目下所有二级类目将一并删除，关联产品会失去类目关联。`)) return;
    const { error } = await supabase.from("categories").delete().eq("id", cat.id);
    if (error) {
      show(error.message, "error");
      return;
    }
    show("类目已删除", "success");
    load();
  }

  async function deleteSubcategory(sub: Subcategory) {
    if (!confirm(`确定删除二级类目「${sub.name_cn}」？`)) return;
    const { error } = await supabase.from("subcategories").delete().eq("id", sub.id);
    if (error) {
      show(error.message, "error");
      return;
    }
    show("二级类目已删除", "success");
    load();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-graphite">类目管理</h1>
          <p className="mt-1 text-sm text-gray-500">维护一级类目与二级类目，影响前台筛选与产品归属</p>
        </div>
        <Button onClick={() => setCatModal("new")}>
          <Plus className="h-4 w-4" /> 新增一级类目
        </Button>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : categories.length === 0 ? (
        <div className="rounded-2xl bg-white p-10 text-center text-sm text-gray-400 ring-1 ring-gray-100">
          暂无类目，点击右上角新增
        </div>
      ) : (
        <div className="space-y-3">
          {categories.map((cat) => {
            const isOpen = expanded[cat.id];
            const subs = subMap[cat.id] || [];
            return (
              <div key={cat.id} className="overflow-hidden rounded-2xl bg-white ring-1 ring-gray-100">
                <div className="flex items-center gap-3 px-4 py-3.5">
                  <button
                    onClick={() => setExpanded((p) => ({ ...p, [cat.id]: !p[cat.id] }))}
                    className="text-gray-400 hover:text-graphite"
                    aria-label={isOpen ? "收起" : "展开"}
                  >
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                  <GripVertical className="h-4 w-4 text-gray-300" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-graphite">{cat.name_cn}</span>
                      {cat.name_en && (
                        <span className="text-xs text-gray-400">/ {cat.name_en}</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-gray-400">
                      slug: {cat.slug} · 排序 {cat.sort_order} · {subs.length} 个二级类目
                    </div>
                  </div>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      cat.is_active ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {cat.is_active ? "启用" : "停用"}
                  </span>
                  <button
                    onClick={() => toggleActive("categories", cat.id, cat.is_active)}
                    className="text-xs text-steel hover:underline"
                  >
                    {cat.is_active ? "停用" : "启用"}
                  </button>
                  <button
                    onClick={() => setCatModal(cat)}
                    className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
                    aria-label="编辑"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => deleteCategory(cat)}
                    className="rounded-md p-1.5 text-red-500 hover:bg-red-50"
                    aria-label="删除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                {isOpen && (
                  <div className="border-t border-gray-50 bg-gray-50/50">
                    <div className="flex items-center justify-between px-4 py-2">
                      <span className="text-xs font-medium text-gray-500">二级类目</span>
                      <button
                        onClick={() => setSubModal({ category: cat, sub: null })}
                        className="inline-flex items-center gap-1 text-xs text-steel hover:underline"
                      >
                        <Plus className="h-3 w-3" /> 新增
                      </button>
                    </div>
                    {subs.length === 0 ? (
                      <div className="px-4 py-3 text-xs text-gray-400">暂无二级类目</div>
                    ) : (
                      <div className="divide-y divide-gray-100">
                        {subs.map((sub) => (
                          <div key={sub.id} className="flex items-center gap-3 px-4 py-2.5">
                            <GripVertical className="h-3.5 w-3.5 text-gray-300" />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm text-graphite">{sub.name_cn}</span>
                                {sub.name_en && (
                                  <span className="text-xs text-gray-400">/ {sub.name_en}</span>
                                )}
                              </div>
                              <div className="text-xs text-gray-400">
                                slug: {sub.slug} · 排序 {sub.sort_order}
                              </div>
                            </div>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] ${
                                sub.is_active
                                  ? "bg-emerald-50 text-emerald-700"
                                  : "bg-gray-100 text-gray-500"
                              }`}
                            >
                              {sub.is_active ? "启用" : "停用"}
                            </span>
                            <button
                              onClick={() => toggleActive("subcategories", sub.id, sub.is_active)}
                              className="text-xs text-steel hover:underline"
                            >
                              {sub.is_active ? "停用" : "启用"}
                            </button>
                            <button
                              onClick={() => setSubModal({ category: cat, sub })}
                              className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
                              aria-label="编辑"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => deleteSubcategory(sub)}
                              className="rounded-md p-1.5 text-red-500 hover:bg-red-50"
                              aria-label="删除"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 一级类目弹窗 */}
      {catModal && (
        <CategoryModal
          initial={catModal === "new" ? null : catModal}
          onClose={() => setCatModal(null)}
          saving={saving}
          setSaving={setSaving}
          onSaved={() => {
            setCatModal(null);
            load();
          }}
        />
      )}

      {/* 二级类目弹窗 */}
      {subModal && (
        <SubcategoryModal
          category={subModal.category}
          initial={subModal.sub}
          onClose={() => setSubModal(null)}
          saving={saving}
          setSaving={setSaving}
          onSaved={() => {
            setSubModal(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ============================================================
// 一级类目表单弹窗
// ============================================================
function CategoryModal({
  initial,
  onClose,
  onSaved,
  saving,
  setSaving,
}: {
  initial: Category | null;
  onClose: () => void;
  onSaved: () => void;
  saving: boolean;
  setSaving: (v: boolean) => void;
}) {
  const supabase = createBrowserSupabaseClient();
  const { show } = useToast();
  const isEdit = !!initial;

  const [form, setForm] = useState({
    name_cn: initial?.name_cn || "",
    name_en: initial?.name_en || "",
    slug: initial?.slug || "",
    description_cn: initial?.description_cn || "",
    description_en: initial?.description_en || "",
    sort_order: initial?.sort_order ?? 0,
    is_active: initial?.is_active ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((p) => ({ ...p, [key]: value }));
  }

  function validate() {
    const e: Record<string, string> = {};
    if (!form.name_cn.trim()) e.name_cn = "请输入中文名称";
    if (!form.slug.trim()) e.slug = "请输入 slug";
    if (!/^[a-z0-9-]+$/.test(form.slug)) e.slug = "slug 只能包含小写字母、数字和连字符";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setSaving(true);
    const payload = {
      name_cn: form.name_cn.trim(),
      name_en: form.name_en.trim() || null,
      slug: form.slug.trim(),
      description_cn: form.description_cn.trim() || null,
      description_en: form.description_en.trim() || null,
      sort_order: Number(form.sort_order) || 0,
      is_active: form.is_active,
    };

    const { error } = isEdit
      ? await supabase.from("categories").update(payload).eq("id", initial!.id)
      : await supabase.from("categories").insert(payload);

    setSaving(false);
    if (error) {
      show(error.message, "error");
      return;
    }
    show(isEdit ? "类目已更新" : "类目已创建", "success");
    onSaved();
  }

  return (
    <Modal title={isEdit ? "编辑一级类目" : "新增一级类目"} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
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
        </div>
        <Input
          label="Slug（URL 标识）"
          required
          value={form.slug}
          onChange={(e) => update("slug", e.target.value)}
          error={errors.slug}
          hint="只能包含小写字母、数字和连字符，例如 fireproof-board"
        />
        <Textarea
          label="中文描述"
          rows={2}
          value={form.description_cn}
          onChange={(e) => update("description_cn", e.target.value)}
        />
        <Textarea
          label="英文描述"
          rows={2}
          value={form.description_en}
          onChange={(e) => update("description_en", e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="排序（数字越小越靠前）"
            type="number"
            value={String(form.sort_order)}
            onChange={(e) => update("sort_order", Number(e.target.value))}
          />
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-700">状态</label>
            <button
              type="button"
              onClick={() => update("is_active", !form.is_active)}
              className={`inline-flex h-11 items-center gap-2 rounded-lg border px-4 text-sm ${
                form.is_active
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                  : "border-gray-200 bg-white text-gray-500"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${form.is_active ? "bg-emerald-500" : "bg-gray-300"}`} />
              {form.is_active ? "启用" : "停用"}
            </button>
          </div>
        </div>
        <FormActions onClose={onClose} saving={saving} isEdit={isEdit} />
      </form>
    </Modal>
  );
}

// ============================================================
// 二级类目表单弹窗
// ============================================================
function SubcategoryModal({
  category,
  initial,
  onClose,
  onSaved,
  saving,
  setSaving,
}: {
  category: Category;
  initial: Subcategory | null;
  onClose: () => void;
  onSaved: () => void;
  saving: boolean;
  setSaving: (v: boolean) => void;
}) {
  const supabase = createBrowserSupabaseClient();
  const { show } = useToast();
  const isEdit = !!initial;

  const [form, setForm] = useState({
    name_cn: initial?.name_cn || "",
    name_en: initial?.name_en || "",
    slug: initial?.slug || "",
    description_cn: initial?.description_cn || "",
    description_en: initial?.description_en || "",
    sort_order: initial?.sort_order ?? 0,
    is_active: initial?.is_active ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((p) => ({ ...p, [key]: value }));
  }

  function validate() {
    const e: Record<string, string> = {};
    if (!form.name_cn.trim()) e.name_cn = "请输入中文名称";
    if (!form.slug.trim()) e.slug = "请输入 slug";
    if (!/^[a-z0-9-]+$/.test(form.slug)) e.slug = "slug 只能包含小写字母、数字和连字符";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setSaving(true);
    const payload = {
      category_id: category.id,
      name_cn: form.name_cn.trim(),
      name_en: form.name_en.trim() || null,
      slug: form.slug.trim(),
      description_cn: form.description_cn.trim() || null,
      description_en: form.description_en.trim() || null,
      sort_order: Number(form.sort_order) || 0,
      is_active: form.is_active,
    };

    const { error } = isEdit
      ? await supabase.from("subcategories").update(payload).eq("id", initial!.id)
      : await supabase.from("subcategories").insert(payload);

    setSaving(false);
    if (error) {
      show(error.message, "error");
      return;
    }
    show(isEdit ? "二级类目已更新" : "二级类目已创建", "success");
    onSaved();
  }

  return (
    <Modal title={isEdit ? "编辑二级类目" : `在「${category.name_cn}」下新增二级类目`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
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
        </div>
        <Input
          label="Slug"
          required
          value={form.slug}
          onChange={(e) => update("slug", e.target.value)}
          error={errors.slug}
        />
        <Textarea
          label="中文描述"
          rows={2}
          value={form.description_cn}
          onChange={(e) => update("description_cn", e.target.value)}
        />
        <Textarea
          label="英文描述"
          rows={2}
          value={form.description_en}
          onChange={(e) => update("description_en", e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="排序"
            type="number"
            value={String(form.sort_order)}
            onChange={(e) => update("sort_order", Number(e.target.value))}
          />
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-700">状态</label>
            <button
              type="button"
              onClick={() => update("is_active", !form.is_active)}
              className={`inline-flex h-11 items-center gap-2 rounded-lg border px-4 text-sm ${
                form.is_active
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                  : "border-gray-200 bg-white text-gray-500"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${form.is_active ? "bg-emerald-500" : "bg-gray-300"}`} />
              {form.is_active ? "启用" : "停用"}
            </button>
          </div>
        </div>
        <FormActions onClose={onClose} saving={saving} isEdit={isEdit} />
      </form>
    </Modal>
  );
}
