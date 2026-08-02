"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { FileUpload } from "@/components/admin/FileUpload";
import { FormActions, Modal } from "@/components/admin/Modal";
import { useToast } from "@/components/admin/Toast";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import {
  authorizeCertificateApi,
  deleteCertificateApi,
  listCertificatesApi,
  publishCertificateApi,
  saveCertificateApi,
  unpublishCertificateApi,
  updateCertificateApi,
  type CertificateSaveResponse,
} from "@/lib/services/admin-fetch";
import type { StorageObjectRef } from "@/lib/services/admin-storage-fetch";
import type { Certificate } from "@/types/database";

const CERT_ERROR_TEXT: Record<string, string> = {
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
  return CERT_ERROR_TEXT[code] ?? "操作失败";
}

export default function CertificatesPage() {
  const { show } = useToast();
  const [list, setList] = useState<Certificate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Certificate | "new" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await listCertificatesApi();
    if (!result.ok) {
      show(errorText(result.code), "error");
      setList([]);
      setLoading(false);
      return;
    }
    setList(result.data.certificates);
    setLoading(false);
  }, [show]);

  useEffect(() => {
    load();
  }, [load]);

  async function publish(c: Certificate) {
    if (!c.updated_at) {
      show("缺少 updated_at，无法发布", "error");
      return;
    }
    if (c.authorization_status !== "confirmed") {
      show("请先完成授权确认后再发布", "error");
      return;
    }
    const result = await publishCertificateApi(c.id, c.updated_at);
    if (!result.ok) {
      show(errorText(result.code), "error");
      return;
    }
    show("证书已发布");
    load();
  }

  async function unpublish(c: Certificate) {
    if (!c.updated_at) {
      show("缺少 updated_at，无法下架", "error");
      return;
    }
    const result = await unpublishCertificateApi(c.id, c.updated_at);
    if (!result.ok) {
      show(errorText(result.code), "error");
      return;
    }
    show("证书已下架");
    load();
  }

  async function authorize(c: Certificate) {
    if (!c.updated_at) {
      show("缺少 updated_at，无法授权", "error");
      return;
    }
    if (!confirm(`确认证书「${c.name_cn}」是展示版/水印版/已获授权资料？此操作将记录审计日志。`)) {
      return;
    }
    const result = await authorizeCertificateApi(c.id, c.updated_at);
    if (!result.ok) {
      show(errorText(result.code), "error");
      return;
    }
    show("已授权确认");
    load();
  }

  async function remove(c: Certificate) {
    if (!c.updated_at) {
      show("缺少 updated_at，无法删除", "error");
      return;
    }
    if (!confirm(`确定删除证书「${c.name_cn}」？将同步入队清理 Storage 对象。`)) return;
    const result = await deleteCertificateApi(c.id, c.updated_at);
    if (!result.ok) {
      show(errorText(result.code), "error");
      return;
    }
    setList((prev) => prev.filter((it) => it.id !== c.id));
    show("证书记录已删除");
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
              以防止证书被冒用。新证书默认保存为 private-assets 草稿，需授权确认后才能发布到 public-assets。
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
          {list.map((c) => {
            const isPublished =
              c.publish_status === "published" ||
              (c.publish_status === undefined && c.is_published);
            const isPublishing = c.publish_status === "publishing";
            const canAuthorize = c.authorization_status !== "confirmed";
            const canPublish = c.authorization_status === "confirmed" && !isPublished && !isPublishing;
            return (
              <div
                key={c.id}
                className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-100"
              >
                <div className="relative aspect-[3/4] bg-gray-100">
                  {c.image_url ? (
                    <img
                      src={c.image_url}
                      alt={c.name_cn}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-xs text-gray-400">
                      <span>草稿未发布</span>
                      {c.source_object_path && (
                        <span className="px-2 text-center text-[10px] text-gray-300">
                          {c.source_object_path}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        isPublished
                          ? "bg-emerald-500 text-white"
                          : isPublishing
                            ? "bg-amber-500 text-white"
                            : "bg-white/90 text-gray-600"
                      }`}
                    >
                      {isPublished ? "已发布" : isPublishing ? "发布中" : "草稿"}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        c.authorization_status === "confirmed"
                          ? "bg-steel/90 text-white"
                          : "bg-white/90 text-gray-500"
                      }`}
                    >
                      {c.authorization_status === "confirmed" ? "已授权" : "未授权"}
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
                    {canAuthorize && (
                      <button
                        onClick={() => authorize(c)}
                        className="flex-1 rounded-md border border-steel/30 py-1.5 text-xs text-steel hover:bg-steel/10"
                        title="授权确认"
                      >
                        授权
                      </button>
                    )}
                    {canPublish && (
                      <button
                        onClick={() => publish(c)}
                        className="flex-1 rounded-md border border-emerald-200 py-1.5 text-xs text-emerald-600 hover:bg-emerald-50"
                      >
                        发布
                      </button>
                    )}
                    {isPublished && (
                      <button
                        onClick={() => unpublish(c)}
                        className="flex-1 rounded-md border border-amber-200 py-1.5 text-xs text-amber-600 hover:bg-amber-50"
                      >
                        下架
                      </button>
                    )}
                    <button
                      onClick={() => setEditing(c)}
                      className="rounded-md border border-gray-200 p-1.5 text-gray-500 hover:bg-gray-50"
                      aria-label="编辑"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => remove(c)}
                      className="rounded-md border border-red-200 p-1.5 text-red-500 hover:bg-red-50"
                      aria-label="删除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <CertificateModal
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
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
}: {
  initial: Certificate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { show } = useToast();
  const isEdit = Boolean(initial);
  const [saving, setSaving] = useState(false);
  // draftSourceRef 跟踪本次会话中新上传的 private-assets source 对象
  const [draftSourceRef, setDraftSourceRef] = useState<StorageObjectRef | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const [form, setForm] = useState({
    name_cn: initial?.name_cn || "",
    name_en: initial?.name_en || "",
    description_cn: initial?.description_cn || "",
    description_en: initial?.description_en || "",
    applicable_scope_cn: initial?.applicable_scope_cn || "",
    applicable_scope_en: initial?.applicable_scope_en || "",
    sort_order: initial?.sort_order ?? 0,
    // 展示用：已发布 URL 保留显示
    image_url_display: initial?.image_url || "",
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
    if (!confirmed) {
      show("请先确认该证书为展示版/水印版/已获授权资料", "error");
      return;
    }

    // 草稿保存需要 private-assets source path（新上传或保留自既有行）
    if (!draftSourceRef && !initial?.source_object_path) {
      show("请上传证书图片（private-assets 草稿）", "error");
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

    const metadataPayload = {
      name_cn: form.name_cn.trim(),
      name_en: form.name_en.trim() || null,
      description_cn: form.description_cn.trim() || null,
      description_en: form.description_en.trim() || null,
      applicable_scope_cn: form.applicable_scope_cn.trim() || null,
      applicable_scope_en: form.applicable_scope_en.trim() || null,
      sort_order: Number(form.sort_order) || 0,
      is_published: false, // 草稿不发布
    };

    setSaving(true);

    let result:
      | { ok: true; data: CertificateSaveResponse }
      | { ok: false; code: string; status: number };

    if (isEdit && initial) {
      // 编辑既有记录：
      //   - 若新上传了 source → 走 saveCertificateApi（带新 sourceObjectPath）
      //   - 否则只更新 metadata → 走 updateCertificateApi
      if (draftSourceRef) {
        result = await saveCertificateApi({
          id: initial.id,
          expectedUpdatedAt: initial.updated_at,
          payload: metadataPayload as unknown as Record<string, unknown>,
          sourceBucket: "private-assets",
          sourceObjectPath: sourceRef.path,
          mimeType: sourceRef.mimeType ?? null,
          fileSize: sourceRef.size ?? null,
          sha256: null,
          accessLevel: "public",
          sourceType: initial.source_type ?? "official",
        });
      } else {
        result = await updateCertificateApi(initial.id, {
          expectedUpdatedAt: initial.updated_at,
          payload: metadataPayload as unknown as Record<string, unknown>,
          accessLevel: initial.access_level ?? "public",
          sourceType: initial.source_type ?? "official",
        });
      }
    } else {
      // 新建：必须走 saveCertificateApi（带 sourceObjectPath）
      result = await saveCertificateApi({
        payload: metadataPayload as unknown as Record<string, unknown>,
        sourceBucket: "private-assets",
        sourceObjectPath: sourceRef.path,
        mimeType: sourceRef.mimeType ?? null,
        fileSize: sourceRef.size ?? null,
        sha256: null,
        accessLevel: "public",
        sourceType: "official",
      });
    }

    setSaving(false);

    if (!result.ok) {
      show(errorText(result.code), "error");
      return;
    }

    show(isEdit ? "证书草稿已更新" : "证书草稿已创建，请进行授权确认后再发布");
    onSaved();
  }

  return (
    <Modal title={isEdit ? "编辑证书" : "新增证书"} onClose={onClose} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-sm font-medium text-gray-700">证书图片（private-assets 草稿）</p>
            <FileUpload
              purpose="certificate-draft"
              accept="image/jpeg,image/png,image/webp"
              hint="JPG/PNG/WebP，最大 5MB；保存为 private-assets 草稿，授权确认后单独发布到 public-assets。"
              onUploaded={() => {
                /* ref 通过 onUploadedRef 捕获 */
              }}
              onUploadedRef={(ref) => {
                setDraftSourceRef(ref);
              }}
              label="上传证书草稿"
            />
            <p className="mt-1 text-[11px] text-gray-400">
              当前草稿路径：{draftSourceRef?.path || initial?.source_object_path || "(未上传)"}
            </p>
          </div>
          <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs text-gray-600">
            <p className="font-medium text-gray-700">发布流程</p>
            <ol className="mt-2 list-decimal space-y-1 pl-4">
              <li>上传展示版/水印版证书图片（private-assets 草稿）</li>
              <li>填写证书信息并保存草稿</li>
              <li>在列表点 &quot;授权&quot; 确认（记录审计）</li>
              <li>点 &quot;发布&quot; 触发 claim/finalize 协议，迁移到 public-assets</li>
              <li>前台公开访问使用 public-assets URL</li>
            </ol>
            {form.image_url_display && (
              <p className="mt-2 break-all border-t border-gray-200 pt-2">
                <span className="font-medium">已发布 URL（保留）：</span>
                <span className="ml-1">{form.image_url_display}</span>
              </p>
            )}
          </div>
        </div>

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
        </div>
        <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            我确认该证书图片是允许公开展示的展示版、水印版或已获授权资料，不是完整高清源文件。
            保存为草稿后仍需在列表中单独完成 &quot;授权确认&quot; 才能发布。
          </span>
        </label>
        <FormActions onClose={onClose} saving={saving} isEdit={isEdit} />
      </form>
    </Modal>
  );
}
