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
import {
  authorizeProductAssetApi,
  deleteProductAssetApi,
  listProductAssetsApi,
  publishProductAssetApi,
  saveProductAssetApi,
  unpublishProductAssetApi,
  updateProductAssetApi,
  type ProductAssetPublishResponse,
  type ProductAssetSaveResponse,
} from "@/lib/services/admin-fetch";
import type { StorageObjectRef } from "@/lib/services/admin-storage-fetch";
import {
  formatFieldErrors,
  validateProductAssetPayload,
} from "@/lib/validation/product-asset";
import type { Product, ProductAsset, ProductAssetType } from "@/types/database";

const assetTypes: Array<{ value: ProductAssetType; label: string }> = [
  { value: "catalog", label: "产品目录" },
  { value: "datasheet", label: "技术资料" },
  { value: "installation", label: "安装说明" },
  { value: "certificate", label: "证书资料" },
  { value: "packaging", label: "包装资料" },
  { value: "other", label: "其他" },
];

function topicLabel(topicId: string | null | undefined): string {
  if (!topicId) return "未绑定主题";
  return catalogTopics.find((topic) => topic.id === topicId)?.titleCn || topicId;
}

const ASSET_ERROR_TEXT: Record<string, string> = {
  ADMIN_WRITE_UNAUTHORIZED: "未登录或会话已过期",
  ADMIN_WRITE_FORBIDDEN_ORIGIN: "请求来源被拒绝",
  ADMIN_WRITE_FORBIDDEN_ROLE: "权限不足",
  ADMIN_WRITE_BAD_REQUEST: "参数错误",
  ADMIN_WRITE_CONFLICT: "数据已被他人更新，请刷新后重试",
  ADMIN_WRITE_FAILED: "操作失败",
  ADMIN_WRITE_NETWORK: "网络错误",
  ADMIN_WRITE_DEMO: "Demo 模式下不可写",
};

function errorText(code: string): string {
  return ASSET_ERROR_TEXT[code] ?? "操作失败";
}

export default function ProductAssetsAdminPage() {
  const { show } = useToast();
  const [assets, setAssets] = useState<ProductAsset[]>([]);
  const [editing, setEditing] = useState<ProductAsset | "new" | null>(null);
  const [previewing, setPreviewing] = useState<ProductAsset | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [topicFilter, setTopicFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const result = await listProductAssetsApi();
    if (!result.ok) {
      show(errorText(result.code), "error");
      setAssets([]);
      setLoading(false);
      return;
    }
    setAssets(result.data.assets);
    setLoading(false);
  }, [show]);

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

  async function publish(asset: ProductAsset) {
    if (!asset.updated_at) {
      show("缺少 updated_at，无法发布", "error");
      return;
    }
    const result = await publishProductAssetApi(asset.id, asset.updated_at);
    if (!result.ok) {
      show(errorText(result.code), "error");
      return;
    }
    show("资料已发布");
    load();
  }

  async function unpublish(asset: ProductAsset) {
    if (!asset.updated_at) {
      show("缺少 updated_at，无法下架", "error");
      return;
    }
    const result = await unpublishProductAssetApi(asset.id, asset.updated_at);
    if (!result.ok) {
      show(errorText(result.code), "error");
      return;
    }
    show("资料已下架");
    load();
  }

  async function remove(asset: ProductAsset) {
    if (!asset.updated_at) {
      show("缺少 updated_at，无法删除", "error");
      return;
    }
    if (!confirm(`确定删除资料「${asset.title_cn}」？将同步入队清理 Storage 对象。`)) return;
    const result = await deleteProductAssetApi(asset.id, asset.updated_at);
    if (!result.ok) {
      show(errorText(result.code), "error");
      return;
    }
    setAssets((rows) => rows.filter((row) => row.id !== asset.id));
    show("资料记录已删除");
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
            <tbody className="divide-y divide-gray-50">{filteredAssets.map((asset) => {
              const isPublished = asset.publish_status === "published" || (asset.publish_status === undefined && asset.is_published);
              const canPublish = (asset.authorization_status === "confirmed") && !isPublished;
              return (
                <tr key={asset.id}>
                  <td className="p-4"><div className="flex items-center gap-3">{asset.cover_image_url ? <span className="h-12 w-10 shrink-0 rounded bg-gray-100 bg-cover bg-center" style={{ backgroundImage: `url(${asset.cover_image_url})` }} /> : <span className="flex h-12 w-10 shrink-0 items-center justify-center rounded bg-gray-100"><FileText className="h-4 w-4 text-steel" /></span>}<div><p className="font-medium text-graphite">{asset.title_cn}</p><p className="mt-0.5 max-w-xs truncate text-[11px] text-gray-400">{asset.file_url || "(草稿未发布)"}</p></div></div></td>
                  <td className="p-4 text-xs text-gray-600">{topicLabel(asset.catalog_topic_id)}</td>
                  <td className="p-4 text-xs text-gray-600">{asset.product_id ? "产品资料" : "站点通用"}</td>
                  <td className="p-4 text-xs text-gray-600">{assetTypes.find((item) => item.value === asset.asset_type)?.label}</td>
                  <td className="p-4 text-xs text-gray-600">{asset.published_at || "—"}</td>
                  <td className="p-4 text-xs">{asset.sort_order}</td>
                  <td className="p-4"><span className={isPublished ? "rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700" : "rounded bg-gray-100 px-2 py-1 text-xs text-gray-500"}>{isPublished ? "已发布" : asset.publish_status === "publishing" ? "发布中" : "草稿"}</span></td>
                  <td className="p-4"><div className="flex justify-end gap-1">{canPreviewProductAsset(asset) && <button type="button" onClick={() => setPreviewing(asset)} className="rounded p-2 text-steel hover:bg-gray-50" aria-label="预览"><Eye className="h-4 w-4" /></button>}{canPublish && <button type="button" onClick={() => publish(asset)} className="rounded p-2 text-emerald-600 hover:bg-emerald-50" aria-label="发布" title="发布">+</button>}{isPublished && <button type="button" onClick={() => unpublish(asset)} className="rounded p-2 text-amber-600 hover:bg-amber-50" aria-label="下架" title="下架">−</button>}<button type="button" onClick={() => setEditing(asset)} className="rounded p-2 text-gray-500 hover:bg-gray-50" aria-label="编辑"><Pencil className="h-4 w-4" /></button><button type="button" onClick={() => remove(asset)} className="rounded p-2 text-red-500 hover:bg-red-50" aria-label="删除"><Trash2 className="h-4 w-4" /></button></div></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      ) : <div className="rounded-xl bg-white p-12 text-center text-sm text-gray-400 ring-1 ring-gray-100">没有符合筛选条件的资料</div>}
      {editing && <AssetModal initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {previewing && <ProductAssetViewer asset={previewing} locale="zh" onClose={() => setPreviewing(null)} />}
    </div>
  );
}

function AssetModal({ initial, onClose, onSaved }: { initial: ProductAsset | null; onClose: () => void; onSaved: () => void }) {
  const { show } = useToast();
  const [saving, setSaving] = useState(false);
  const [confirmed, setConfirmed] = useState(Boolean(initial));
  // draftSourceRef 跟踪本次会话中新上传的 private-assets source 对象
  const [draftSourceRef, setDraftSourceRef] = useState<StorageObjectRef | null>(null);
  const [form, setForm] = useState({
    product_id: initial?.product_id || "",
    asset_type: initial?.asset_type || "catalog" as ProductAssetType,
    catalog_topic_id: initial?.catalog_topic_id || "",
    title_cn: initial?.title_cn || "",
    title_en: initial?.title_en || "",
    description_cn: initial?.description_cn || "",
    description_en: initial?.description_en || "",
    cover_image_url: initial?.cover_image_url || "",
    published_at: initial?.published_at || "",
    content_hash: initial?.content_hash || "",
    is_published: initial?.is_published || false,
    sort_order: initial?.sort_order || 0,
    // For display only: existing published URL preserved across draft edits.
    file_url_display: initial?.file_url || "",
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
    if (!confirmed) { show("请先确认文件允许公开展示", "error"); return; }

    // Draft save requires a private-assets source path (either newly uploaded
    // or preserved from the existing row). We do not save file_url into the
    // draft; the server RPC keeps it null or preserves the previous public URL.
    if (!draftSourceRef && !initial?.source_object_path) {
      show("请上传 Catalog 资产文件（private-assets 草稿）", "error");
      return;
    }

    const sourceRef = draftSourceRef ?? {
      bucket: "private-assets" as const,
      path: initial?.source_object_path ?? "",
      publicUrl: null,
      mimeType: initial?.mime_type ?? null,
      size: initial?.file_size ?? null,
    };

    if (!sourceRef.path) {
      show("缺少 private-assets 草稿路径", "error");
      return;
    }

    const payload = {
      product_id: form.product_id || null,
      asset_type: form.asset_type,
      catalog_topic_id: form.catalog_topic_id || null,
      title_cn: form.title_cn.trim(),
      title_en: form.title_en.trim() || null,
      description_cn: form.description_cn.trim() || null,
      description_en: form.description_en.trim() || null,
      file_url: "", // Draft: not saved (RPC keeps null or prev public URL)
      cover_image_url: form.cover_image_url.trim() || null,
      published_at: form.published_at || null,
      content_hash: form.content_hash || null,
      is_published: false, // Draft is never published
      sort_order: Number(form.sort_order) || 0,
    };

    const validation = validateProductAssetPayload(payload);
    if (!validation.ok) {
      show(formatFieldErrors(validation.errors), "error");
      return;
    }

    setSaving(true);

    const apiPayload = {
      id: initial?.id,
      expectedUpdatedAt: initial?.updated_at ?? null,
      payload: payload as unknown as Record<string, unknown>,
      sourceBucket: "private-assets" as const,
      sourceObjectPath: sourceRef.path,
      mimeType: sourceRef.mimeType ?? null,
      fileSize: sourceRef.size ?? null,
      sha256: null,
      accessLevel: "public" as const,
      sourceType: "official" as const,
    };

    const result: AdminFetchResult<ProductAssetSaveResponse> = initial
      ? await updateProductAssetApi(initial.id, {
          expectedUpdatedAt: initial.updated_at,
          payload: apiPayload.payload,
          accessLevel: "public",
          sourceType: "official",
        })
      : await saveProductAssetApi(apiPayload);

    setSaving(false);

    if (!result.ok) {
      show(errorText(result.code), "error");
      return;
    }

    show(initial ? "资料已更新" : "资料已创建");
    onSaved();
  }

  return (
    <Modal title={initial ? "编辑采购资料" : "新增采购资料"} onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="mb-1.5 block text-sm font-medium text-gray-700">资料类型</label><select value={form.asset_type} onChange={(event) => update("asset_type", event.target.value as ProductAssetType)} className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm">{assetTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
        </div>
        <div><label className="mb-1.5 block text-sm font-medium text-gray-700">Catalog 主题</label><select value={form.catalog_topic_id} onChange={(event) => selectTopic(event.target.value)} className="h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm"><option value="">不绑定 21 个核心主题</option>{catalogTopics.map((topic) => <option key={topic.id} value={topic.id}>{topic.titleCn} · {topic.titleEn}</option>)}</select></div>
        <div className="grid gap-3 sm:grid-cols-2"><Input label="中文标题" required value={form.title_cn} onChange={(event) => update("title_cn", event.target.value)} /><Input label="英文标题" value={form.title_en} onChange={(event) => update("title_en", event.target.value)} /></div>
        <div className="grid gap-3 sm:grid-cols-2"><Textarea label="中文描述" rows={2} value={form.description_cn} onChange={(event) => update("description_cn", event.target.value)} /><Textarea label="英文描述" rows={2} value={form.description_en} onChange={(event) => update("description_en", event.target.value)} /></div>
        <div className="grid gap-4 rounded-lg border border-gray-100 p-3 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-sm font-medium text-gray-700">资料文件（private-assets 草稿）</p>
            <FileUpload
              purpose="catalog-draft"
              onUploaded={() => { /* ref captured via onUploadedRef below */ }}
              onUploadedRef={(ref) => {
                setDraftSourceRef(ref);
                if (ref.mimeType) update("cover_image_url" as never, ref.mimeType as never);
              }}
              label="上传 Catalog 草稿"
              hint="PDF/JPG/PNG/WebP，最大 20MB；保存为 private-assets 草稿，需单独发布到 public-assets。"
            />
            <p className="mt-1 text-[11px] text-gray-400">
              当前草稿路径：{draftSourceRef?.path || initial?.source_object_path || "(未上传)"}
            </p>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium text-gray-700">Catalog 封面（public-assets）</p>
            <FileUpload purpose="catalog-cover" label="上传封面图片" accept="image/jpeg,image/png,image/webp" hint="JPG/PNG/WebP，建议 4:3 或竖版封面。" onUploaded={(file) => update("cover_image_url", file.url)} />
            <Input label="封面 URL" value={form.cover_image_url} onChange={(event) => update("cover_image_url", event.target.value)} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-4"><Input label="发布日期" type="date" value={form.published_at} onChange={(event) => update("published_at", event.target.value)} /><Input label="Content Hash" value={form.content_hash} onChange={(event) => update("content_hash", event.target.value)} /><Input label="排序" type="number" value={String(form.sort_order)} onChange={(event) => update("sort_order", Number(event.target.value))} /></div>
        {form.file_url_display && (
          <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs text-gray-600">
            <span className="font-medium">已发布 URL（保留）：</span>
            <span className="ml-1 break-all">{form.file_url_display}</span>
          </div>
        )}
        <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5" /><span>我确认该文件是允许公开的展示版、水印版或已获授权资料，不是内部源文件。</span></label>
        <FormActions onClose={onClose} saving={saving} isEdit={Boolean(initial)} />
      </form>
    </Modal>
  );
}

// Local type alias to avoid importing AdminFetchResult from admin-fetch
// (kept here so the AssetModal signature stays self-contained).
type AdminFetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; status: number };
