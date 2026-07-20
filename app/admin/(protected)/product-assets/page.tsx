"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, FileText, Loader2, Pencil, Plus, Search, ShieldAlert, Trash2 } from "lucide-react";
import { FileUpload } from "@/components/admin/FileUpload";
import { FormActions, Modal } from "@/components/admin/Modal";
import { useToast } from "@/components/admin/Toast";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { ProductAssetViewer, canPreviewProductAsset } from "@/components/public/ProductAssetViewer";
import { catalogTopics } from "@/lib/catalog-topics";
import { deleteProductAsset, listProductAssets, saveProductAsset } from "@/lib/repositories/product-assets";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import type { Product, ProductAsset, ProductAssetType } from "@/types/database";

const assetTypes: Array<{ value: ProductAssetType; label: string }> = [
  { value: "catalog", label: "产品目录" },
  { value: "datasheet", label: "技术资料" },
  { value: "installation", label: "安装说明" },
  { value: "certificate", label: "证书资料" },
  { value: "packaging", label: "包装资料" },
  { value: "other", label: "其他" },
];

function topicLabel(topicId: string | null): string {
  if (!topicId) return "未绑定主题";
  return catalogTopics.find((topic) => topic.id === topicId)?.titleCn || topicId;
}

function payloadFromAsset(asset: ProductAsset) {
  return {
    product_id: asset.product_id,
    asset_type: asset.asset_type,
    catalog_topic_id: asset.catalog_topic_id || null,
    title_cn: asset.title_cn,
    title_en: asset.title_en,
    description_cn: asset.description_cn,
    description_en: asset.description_en,
    file_url: asset.file_url,
    cover_image_url: asset.cover_image_url || null,
    file_size: asset.file_size,
    mime_type: asset.mime_type,
    published_at: asset.published_at || null,
    content_hash: asset.content_hash || null,
    is_published: asset.is_published,
    sort_order: asset.sort_order,
  };
}

export default function ProductAssetsAdminPage() {
  const client = createBrowserSupabaseClient();
  const { show } = useToast();
  const [assets, setAssets] = useState<ProductAsset[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [editing, setEditing] = useState<ProductAsset | "new" | null>(null);
  const [previewing, setPreviewing] = useState<ProductAsset | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [topicFilter, setTopicFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [assetRows, productResult] = await Promise.all([
        listProductAssets(client),
        client.from("products").select("*").order("name_cn", { ascending: true }),
      ]);
      setAssets(assetRows);
      setProducts((productResult.data as Product[] | null) || []);
    } catch (error) {
      show(error instanceof Error ? error.message : "读取资料失败", "error");
    }
    setLoading(false);
  }, [client, show]);

  useEffect(() => { load(); }, [load]);

  const filteredAssets = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return assets.filter((asset) => {
      if (topicFilter && asset.catalog_topic_id !== topicFilter) return false;
      if (typeFilter && asset.asset_type !== typeFilter) return false;
      if (statusFilter === "published" && !asset.is_published) return false;
      if (statusFilter === "draft" && asset.is_published) return false;
      if (!keyword) return true;
      return [asset.title_cn, asset.title_en || "", asset.description_cn || "", asset.description_en || ""]
        .some((value) => value.toLowerCase().includes(keyword));
    });
  }, [assets, search, statusFilter, topicFilter, typeFilter]);

  async function toggle(asset: ProductAsset) {
    try {
      await saveProductAsset(client, { ...payloadFromAsset(asset), is_published: !asset.is_published }, asset.id);
      setAssets((rows) => rows.map((row) => row.id === asset.id ? { ...row, is_published: !row.is_published } : row));
      show(asset.is_published ? "资料已下架" : "资料已发布");
    } catch (error) {
      show(error instanceof Error ? error.message : "操作失败", "error");
    }
  }

  async function remove(asset: ProductAsset) {
    if (!confirm(`确定删除资料「${asset.title_cn}」？仅删除数据库记录，不会自动删除 Storage 文件。`)) return;
    try {
      await deleteProductAsset(client, asset.id);
      setAssets((rows) => rows.filter((row) => row.id !== asset.id));
      show("资料记录已删除");
    } catch (error) {
      show(error instanceof Error ? error.message : "删除失败", "error");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div><h1 className="text-xl font-bold text-graphite">采购资料与目录中心</h1><p className="mt-1 text-sm text-gray-500">管理站点级目录、色卡、认证文件与产品级公开资料</p></div>
        <Button onClick={() => setEditing("new")}><Plus className="h-4 w-4" />新增资料</Button>
      </div>
      <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800"><ShieldAlert className="h-4 w-4 shrink-0" /><p>只允许上传公开展示版、水印版或已获授权的资料。禁止上传内部源文件、未公开证书和敏感商业资料。</p></div>

      <div className="grid gap-3 rounded-xl bg-white p-4 ring-1 ring-gray-100 md:grid-cols-4">
        <label className="relative md:col-span-1"><Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题或描述" className="h-10 w-full rounded-lg border border-gray-200 pl-9 pr-3 text-sm" /></label>
        <select value={topicFilter} onChange={(event) => setTopicFilter(event.target.value)} className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm"><option value="">全部目录主题</option>{catalogTopics.map((topic) => <option key={topic.id} value={topic.id}>{topic.titleCn}</option>)}</select>
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm"><option value="">全部资料类型</option>{assetTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm"><option value="">全部状态</option><option value="published">已发布</option><option value="draft">草稿</option></select>
      </div>

      {loading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div> : filteredAssets.length ? (
        <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-gray-100">
          <table className="w-full min-w-[1080px] text-left text-sm">
            <thead className="border-b border-gray-100 text-xs text-gray-500"><tr><th className="p-4">资料</th><th className="p-4">目录主题</th><th className="p-4">归属</th><th className="p-4">类型</th><th className="p-4">发布日期</th><th className="p-4">排序</th><th className="p-4">状态</th><th className="p-4 text-right">操作</th></tr></thead>
            <tbody className="divide-y divide-gray-50">{filteredAssets.map((asset) => (
              <tr key={asset.id}>
                <td className="p-4"><div className="flex items-center gap-3">{asset.cover_image_url ? <span className="h-12 w-10 shrink-0 rounded bg-gray-100 bg-cover bg-center" style={{ backgroundImage: `url(${asset.cover_image_url})` }} /> : <span className="flex h-12 w-10 shrink-0 items-center justify-center rounded bg-gray-100"><FileText className="h-4 w-4 text-steel" /></span>}<div><p className="font-medium text-graphite">{asset.title_cn}</p><p className="mt-0.5 max-w-xs truncate text-[11px] text-gray-400">{asset.file_url}</p></div></div></td>
                <td className="p-4 text-xs text-gray-600">{topicLabel(asset.catalog_topic_id)}</td>
                <td className="p-4 text-xs text-gray-600">{asset.product_id ? products.find((product) => product.id === asset.product_id)?.name_cn || "产品已删除" : "站点通用"}</td>
                <td className="p-4 text-xs text-gray-600">{assetTypes.find((item) => item.value === asset.asset_type)?.label}</td>
                <td className="p-4 text-xs text-gray-600">{asset.published_at || "—"}</td>
                <td className="p-4 text-xs">{asset.sort_order}</td>
                <td className="p-4"><button type="button" onClick={() => toggle(asset)} className={asset.is_published ? "rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700" : "rounded bg-gray-100 px-2 py-1 text-xs text-gray-500"}>{asset.is_published ? "已发布" : "草稿"}</button></td>
                <td className="p-4"><div className="flex justify-end gap-1">{canPreviewProductAsset(asset) && <button type="button" onClick={() => setPreviewing(asset)} className="rounded p-2 text-steel hover:bg-gray-50" aria-label="预览"><Eye className="h-4 w-4" /></button>}<button type="button" onClick={() => setEditing(asset)} className="rounded p-2 text-gray-500 hover:bg-gray-50" aria-label="编辑"><Pencil className="h-4 w-4" /></button><button type="button" onClick={() => remove(asset)} className="rounded p-2 text-red-500 hover:bg-red-50" aria-label="删除"><Trash2 className="h-4 w-4" /></button></div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <div className="rounded-xl bg-white p-12 text-center text-sm text-gray-400 ring-1 ring-gray-100">没有符合筛选条件的资料</div>}
      {editing && <AssetModal initial={editing === "new" ? null : editing} products={products} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {previewing && <ProductAssetViewer asset={previewing} locale="zh" onClose={() => setPreviewing(null)} />}
    </div>
  );
}

function AssetModal({ initial, products, onClose, onSaved }: { initial: ProductAsset | null; products: Product[]; onClose: () => void; onSaved: () => void }) {
  const client = createBrowserSupabaseClient();
  const { show } = useToast();
  const [saving, setSaving] = useState(false);
  const [confirmed, setConfirmed] = useState(Boolean(initial));
  const [form, setForm] = useState({
    product_id: initial?.product_id || "",
    asset_type: initial?.asset_type || "catalog" as ProductAssetType,
    catalog_topic_id: initial?.catalog_topic_id || "",
    title_cn: initial?.title_cn || "",
    title_en: initial?.title_en || "",
    description_cn: initial?.description_cn || "",
    description_en: initial?.description_en || "",
    file_url: initial?.file_url || "",
    cover_image_url: initial?.cover_image_url || "",
    file_size: initial?.file_size ? String(initial.file_size) : "",
    mime_type: initial?.mime_type || "",
    published_at: initial?.published_at || "",
    content_hash: initial?.content_hash || "",
    is_published: initial?.is_published || false,
    sort_order: initial?.sort_order || 0,
  });

  function update<K extends keyof typeof form>(key: K, value: typeof form[K]) { setForm((current) => ({ ...current, [key]: value })); }
  function selectTopic(topicId: string) {
    const topic = catalogTopics.find((item) => item.id === topicId);
    setForm((current) => ({
      ...current,
      catalog_topic_id: topicId,
      title_cn: current.title_cn || topic?.titleCn || "",
      title_en: current.title_en || topic?.titleEn || "",
    }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!form.title_cn.trim() || !form.file_url.trim()) { show("请填写中文标题和文件 URL", "error"); return; }
    if (!confirmed) { show("请先确认文件允许公开展示", "error"); return; }
    setSaving(true);
    try {
      await saveProductAsset(client, {
        product_id: form.product_id || null,
        asset_type: form.asset_type,
        catalog_topic_id: form.catalog_topic_id || null,
        title_cn: form.title_cn.trim(),
        title_en: form.title_en.trim() || null,
        description_cn: form.description_cn.trim() || null,
        description_en: form.description_en.trim() || null,
        file_url: form.file_url.trim(),
        cover_image_url: form.cover_image_url.trim() || null,
        file_size: form.file_size ? Math.max(0, Number(form.file_size)) : null,
        mime_type: form.mime_type.trim() || null,
        published_at: form.published_at || null,
        content_hash: form.content_hash || null,
        is_published: form.is_published,
        sort_order: Number(form.sort_order) || 0,
      }, initial?.id);
      show(initial ? "资料已更新" : "资料已创建");
      onSaved();
    } catch (error) {
      show(error instanceof Error ? error.message : "保存失败", "error");
    } finally {
      setSaving(false);
    }
  }

  const folderTopic = form.catalog_topic_id || "general";
  return (
    <Modal title={initial ? "编辑采购资料" : "新增采购资料"} onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="mb-1.5 block text-sm font-medium text-gray-700">归属</label><select value={form.product_id} onChange={(event) => update("product_id", event.target.value)} className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm"><option value="">站点级通用资料</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name_cn}</option>)}</select></div>
          <div><label className="mb-1.5 block text-sm font-medium text-gray-700">资料类型</label><select value={form.asset_type} onChange={(event) => update("asset_type", event.target.value as ProductAssetType)} className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm">{assetTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
        </div>
        <div><label className="mb-1.5 block text-sm font-medium text-gray-700">Catalog 主题</label><select value={form.catalog_topic_id} onChange={(event) => selectTopic(event.target.value)} className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm"><option value="">不绑定 21 个核心主题</option>{catalogTopics.map((topic) => <option key={topic.id} value={topic.id}>{topic.titleCn} · {topic.titleEn}</option>)}</select></div>
        <div className="grid gap-3 sm:grid-cols-2"><Input label="中文标题" required value={form.title_cn} onChange={(event) => update("title_cn", event.target.value)} /><Input label="英文标题" value={form.title_en} onChange={(event) => update("title_en", event.target.value)} /></div>
        <div className="grid gap-3 sm:grid-cols-2"><Textarea label="中文描述" rows={2} value={form.description_cn} onChange={(event) => update("description_cn", event.target.value)} /><Textarea label="英文描述" rows={2} value={form.description_en} onChange={(event) => update("description_en", event.target.value)} /></div>
        <div className="grid gap-4 rounded-lg border border-gray-100 p-3 sm:grid-cols-2"><div><p className="mb-2 text-sm font-medium text-gray-700">资料文件</p><FileUpload folder={`documents/catalogs/${folderTopic}`} onUploaded={(file) => setForm((current) => ({ ...current, file_url: file.url, file_size: String(file.size), mime_type: file.mimeType }))} /><Input label="文件 URL" required value={form.file_url} onChange={(event) => update("file_url", event.target.value)} /></div><div><p className="mb-2 text-sm font-medium text-gray-700">Catalog 封面</p><FileUpload folder={`document-covers/${folderTopic}`} label="上传封面图片" accept="image/jpeg,image/png,image/webp" hint="JPG/PNG/WebP，建议 4:3 或竖版封面。" onUploaded={(file) => update("cover_image_url", file.url)} /><Input label="封面 URL" value={form.cover_image_url} onChange={(event) => update("cover_image_url", event.target.value)} /></div></div>
        <div className="grid gap-3 sm:grid-cols-4"><Input label="发布日期" type="date" value={form.published_at} onChange={(event) => update("published_at", event.target.value)} /><Input label="文件大小（字节）" type="number" value={form.file_size} onChange={(event) => update("file_size", event.target.value)} /><Input label="MIME 类型" value={form.mime_type} onChange={(event) => update("mime_type", event.target.value)} /><Input label="排序" type="number" value={String(form.sort_order)} onChange={(event) => update("sort_order", Number(event.target.value))} /></div>
        <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5" /><span>我确认该文件是允许公开的展示版、水印版或已获授权资料，不是内部源文件。</span></label>
        <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={form.is_published} onChange={(event) => update("is_published", event.target.checked)} />发布到前台</label>
        <FormActions onClose={onClose} saving={saving} isEdit={Boolean(initial)} />
      </form>
    </Modal>
  );
}
