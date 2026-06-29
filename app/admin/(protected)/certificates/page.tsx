"use client";

import { useEffect, useState, useCallback } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { useToast } from "@/components/admin/Toast";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { ImageUpload } from "@/components/admin/ImageUpload";
import { Modal, FormActions } from "@/app/admin/(protected)/categories/page";
import type { Certificate } from "@/types/database";
import { Plus, Pencil, Trash2, Loader2, ShieldAlert } from "lucide-react";

export default function CertificatesPage() {
  const supabase = createBrowserSupabaseClient();
  const { show } = useToast();

  const [list, setList] = useState<Certificate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Certificate | null | "new">(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("certificates")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });
    setList((data as Certificate[] | null) || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function togglePublish(c: Certificate) {
    const { error } = await supabase
      .from("certificates")
      .update({ is_published: !c.is_published })
      .eq("id", c.id);
    if (error) {
      show(error.message, "error");
      return;
    }
    show(c.is_published ? "已下架" : "已发布", "success");
    setList((prev) =>
      prev.map((it) => (it.id === c.id ? { ...it, is_published: !it.is_published } : it))
    );
  }

  async function handleDelete(c: Certificate) {
    if (!confirm(`确定删除证书「${c.name_cn}」？`)) return;
    const { error } = await supabase.from("certificates").delete().eq("id", c.id);
    if (error) {
      show(error.message, "error");
      return;
    }
    show("证书已删除", "success");
    setList((prev) => prev.filter((it) => it.id !== c.id));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-graphite">证书管理</h1>
          <p className="mt-1 text-sm text-gray-500">资质证书展示，仅上传展示版/水印版图片</p>
        </div>
        <Button onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" /> 新增证书
        </Button>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">安全提示</p>
            <p className="mt-0.5">
              禁止上传完整高清证书源文件。请上传带 &quot;展示版&quot; 水印或压缩后的版本，
              以防止证书被冒用。
            </p>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-2xl bg-white p-10 text-center text-sm text-gray-400 ring-1 ring-gray-100">
          暂无证书
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((c) => (
            <div
              key={c.id}
              className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-100"
            >
              <div className="relative aspect-[3/4] bg-gray-100">
                {c.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={c.image_url}
                    alt={c.name_cn}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-xs text-gray-400">
                    无图片
                  </div>
                )}
                <div className="absolute right-2 top-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      c.is_published
                        ? "bg-emerald-500 text-white"
                        : "bg-white/90 text-gray-600"
                    }`}
                  >
                    {c.is_published ? "已发布" : "草稿"}
                  </span>
                </div>
              </div>
              <div className="p-4">
                <div className="text-sm font-semibold text-graphite">{c.name_cn}</div>
                {c.name_en && <div className="mt-0.5 text-xs text-gray-400">{c.name_en}</div>}
                {c.description_cn && (
                  <p className="mt-2 line-clamp-2 text-xs text-gray-500">{c.description_cn}</p>
                )}
                {c.applicable_scope_cn && (
                  <p className="mt-1 text-[11px] text-gray-400">
                    适用：{c.applicable_scope_cn}
                  </p>
                )}
                <div className="mt-3 flex items-center gap-1.5 border-t border-gray-50 pt-3">
                  <button
                    onClick={() => togglePublish(c)}
                    className="flex-1 rounded-md border border-gray-200 py-1.5 text-xs text-steel hover:bg-steel/10"
                  >
                    {c.is_published ? "下架" : "发布"}
                  </button>
                  <button
                    onClick={() => setEditing(c)}
                    className="rounded-md border border-gray-200 p-1.5 text-gray-500 hover:bg-gray-50"
                    aria-label="编辑"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(c)}
                    className="rounded-md border border-red-200 p-1.5 text-red-500 hover:bg-red-50"
                    aria-label="删除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <CertificateModal
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          saving={saving}
          setSaving={setSaving}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function CertificateModal({
  initial,
  onClose,
  onSaved,
  saving,
  setSaving,
}: {
  initial: Certificate | null;
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
    description_cn: initial?.description_cn || "",
    description_en: initial?.description_en || "",
    image_url: initial?.image_url || "",
    applicable_scope_cn: initial?.applicable_scope_cn || "",
    applicable_scope_en: initial?.applicable_scope_en || "",
    sort_order: initial?.sort_order ?? 0,
    is_published: initial?.is_published ?? false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((p) => ({ ...p, [key]: value }));
  }

  function validate() {
    const e: Record<string, string> = {};
    if (!form.name_cn.trim()) e.name_cn = "请输入证书中文名称";
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
      description_cn: form.description_cn.trim() || null,
      description_en: form.description_en.trim() || null,
      image_url: form.image_url || null,
      applicable_scope_cn: form.applicable_scope_cn.trim() || null,
      applicable_scope_en: form.applicable_scope_en.trim() || null,
      sort_order: Number(form.sort_order) || 0,
      is_published: form.is_published,
    };

    const { error } = isEdit
      ? await supabase.from("certificates").update(payload).eq("id", initial!.id)
      : await supabase.from("certificates").insert(payload);

    setSaving(false);
    if (error) {
      show(error.message, "error");
      return;
    }
    show(isEdit ? "证书已更新" : "证书已创建", "success");
    onSaved();
  }

  return (
    <Modal title={isEdit ? "编辑证书" : "新增证书"} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <ImageUpload
          label="证书图片"
          folder="certificates"
          value={form.image_url}
          onChange={(url) => update("image_url", url)}
          aspect="square"
          hint="仅上传展示版/水印版图片，禁止上传完整高清源文件"
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="中文名称"
            required
            value={form.name_cn}
            onChange={(e) => update("name_cn", e.target.value)}
            error={errors.name_cn}
          />
          <Input
            label="英文名称"
            value={form.name_en}
            onChange={(e) => update("name_en", e.target.value)}
          />
        </div>
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
            label="适用范围（中文）"
            value={form.applicable_scope_cn}
            onChange={(e) => update("applicable_scope_cn", e.target.value)}
            placeholder="例：所有 B 级防火板材"
          />
          <Input
            label="适用范围（英文）"
            value={form.applicable_scope_en}
            onChange={(e) => update("applicable_scope_en", e.target.value)}
          />
        </div>
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
              onClick={() => update("is_published", !form.is_published)}
              className={`inline-flex h-11 items-center gap-2 rounded-lg border px-4 text-sm ${
                form.is_published
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                  : "border-gray-200 bg-white text-gray-500"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${form.is_published ? "bg-emerald-500" : "bg-gray-300"}`} />
              {form.is_published ? "前台展示" : "草稿"}
            </button>
          </div>
        </div>
        <FormActions onClose={onClose} saving={saving} isEdit={isEdit} />
      </form>
    </Modal>
  );
}
