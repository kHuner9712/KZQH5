"use client";

import { useRef, useState } from "react";
import {
  uploadViaServerApi,
  uploadViaServerApiLegacy,
  deleteViaServerApi,
  enqueueCleanupViaServerApi,
} from "@/lib/services/admin-storage-fetch";
import type { StoragePurpose } from "@/lib/services/storage-purpose";
import { cn } from "@/lib/utils";
import { Upload, X, Image as ImageIcon, Loader2 } from "lucide-react";

interface ImageUploadProps {
  value: string;
  onChange: (url: string) => void;
  /**
   * Storage 用途（推荐）。客户端只提交 purpose，服务端决定 bucket / category /
   * MIME 白名单。禁止客户端自动决定公开性。
   *
   * 对应 storage-purpose.ts 中的合法 purpose 值：
   *   - "product-image"   产品展示图（public-assets）
   *   - "project-image"   项目展示图（public-assets）
   *   - "company-logo"    公司品牌资源（public-assets）
   *   - "homepage-image"  首页/OG/Banner（public-assets）
   *   - "catalog-draft"   Catalog 资产（private-assets，需 publish 流程）
   *   - "certificate-draft" 证书图片（private-assets，需 publish 流程）
   *
   * 必须提供 purpose 或 folder 之一。优先使用 purpose。
   */
  purpose?: StoragePurpose;
  /**
   * @deprecated 使用 purpose 代替。Legacy 上传路径，默认上传到 public-assets。
   * 仅用于尚未迁移到 purpose-driven 上传的调用点（certificates、product-assets）。
   */
  folder?: string;
  label?: string;
  hint?: string;
  aspect?: "square" | "wide" | "logo";
}

const aspectClass: Record<NonNullable<ImageUploadProps["aspect"]>, string> = {
  square: "aspect-square",
  wide: "aspect-video",
  logo: "aspect-[3/1]",
};

export function ImageUpload({
  value,
  onChange,
  purpose,
  folder,
  label,
  hint,
  aspect = "wide",
}: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 跟踪本次表单中新上传、尚未保存到 DB 的对象。
   * - handleFile 上传成功后保存 { bucket, path, publicUrl }
   * - handleRemove 时若 newUploadedRef 非空 → 同步删除（reason: form_cancelled）
   * - 已持久化对象（来自 DB 的 value）→ newUploadedRef 为 null，handleRemove
   *   只清空字段，由父组件业务保存时入队 cleanup（reason: replaced | row_deleted）
   */
  const [newUploadedRef, setNewUploadedRef] = useState<{
    bucket: "public-assets" | "private-assets";
    path: string;
    publicUrl: string;
  } | null>(null);

  if (!purpose && !folder) {
    throw new Error(
      "ImageUpload requires either `purpose` (preferred) or `folder` (legacy)",
    );
  }

  // React key 唯一性：优先 folder（历史行为），缺失时回退 purpose
  const inputId = `upload-${folder ?? purpose}`;

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setError("请选择图片文件");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("图片大小不能超过 5MB");
      return;
    }

    setError(null);
    setUploading(true);
    // 优先使用 purpose-driven 上传；缺失时回退到 legacy folder+public=true
    const result = purpose
      ? await uploadViaServerApi(file, purpose)
      : await uploadViaServerApiLegacy(file, folder!);
    setUploading(false);

    if (!result.ok || !result.data.publicUrl) {
      setError(result.ok ? "上传失败" : result.error);
      return;
    }
    // 跟踪本次新上传对象，供 handleRemove 同步删除
    setNewUploadedRef({
      bucket: result.data.bucket as "public-assets" | "private-assets",
      path: result.data.path,
      publicUrl: result.data.publicUrl,
    });
    onChange(result.data.publicUrl);
    // 重置 input 以便相同文件可再次选择
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleRemove() {
    // 本次新上传、尚未保存到 DB 的对象 → 同步删除（不进入 cleanup queue）
    if (newUploadedRef) {
      setRemoving(true);
      const del = await deleteViaServerApi(
        newUploadedRef.bucket,
        newUploadedRef.path,
      );
      setRemoving(false);
      if (!del.ok) {
        // 删除失败：仍清空字段（用户意图），但提示对象残留
        // 残留对象由后续 dispatcher 通过 orphan_detected 路径清理
        setError(del.referenced ? "对象被引用，已标记待清理" : "对象删除失败，已标记待清理");
        // 删除失败时入队 cleanup，由 dispatcher 后续处理
        await enqueueCleanupViaServerApi({
          bucket: newUploadedRef.bucket,
          objectPath: newUploadedRef.path,
          reason: "form_cancelled",
          sourceType: purpose ?? folder,
        });
      }
      setNewUploadedRef(null);
      onChange("");
      setError(null);
      return;
    }

    // 已持久化对象 → 只清空字段，业务保存时由父组件入队 cleanup
    // （reason: replaced 当用户重新上传时；reason: row_deleted 当业务行删除时）
    onChange("");
    setError(null);
  }

  return (
    <div className="space-y-1.5">
      {label && (
        <label className="block text-sm font-medium text-gray-700">{label}</label>
      )}
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "relative w-40 overflow-hidden rounded-lg border border-gray-200 bg-gray-50",
            aspectClass[aspect]
          )}
        >
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={value}
              alt="预览"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-gray-300">
              <ImageIcon className="h-8 w-8" />
            </div>
          )}
          {(uploading || removing) && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/70">
              <Loader2 className="h-5 w-5 animate-spin text-steel" />
            </div>
          )}
        </div>

        <div className="flex-1 space-y-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            onChange={handleFile}
            disabled={uploading}
            className="hidden"
            id={inputId}
          />
          <div className="flex gap-2">
            <label
              htmlFor={inputId}
              className={cn(
                "inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 text-xs text-gray-700 hover:bg-gray-50",
                uploading && "pointer-events-none opacity-50"
              )}
            >
              <Upload className="h-3.5 w-3.5" />
              {value ? "重新上传" : "上传图片"}
            </label>
            {value && (
              <button
                type="button"
                onClick={handleRemove}
                disabled={removing}
                className="inline-flex h-9 items-center gap-1 rounded-md px-2 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" /> {removing ? "移除中…" : "移除"}
              </button>
            )}
          </div>
          {hint && <p className="text-xs text-gray-400">{hint}</p>}
          {error && <p className="text-xs text-red-500">{error}</p>}
          {value && (
            <input
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="h-9 w-full rounded-md border border-gray-200 bg-white px-2.5 text-xs text-gray-600 outline-none focus:border-steel"
              placeholder="或手动填写图片 URL"
            />
          )}
        </div>
      </div>
    </div>
  );
}
