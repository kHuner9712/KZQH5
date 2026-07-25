"use client";

import { useEffect, useRef, useState } from "react";
import {
  uploadViaServerApi,
  deleteViaServerApi,
  enqueueCleanupViaServerApi,
  fetchPrivatePreviewUrl,
  type StorageObjectRef,
} from "@/lib/services/admin-storage-fetch";
import type { StoragePurpose } from "@/lib/services/storage-purpose";
import { cn } from "@/lib/utils";
import { Upload, X, Image as ImageIcon, Loader2 } from "lucide-react";

interface ImageUploadProps {
  /**
   * 当前值。两种形式：
   *   1. public-assets 的公开 URL（http/https）
   *   2. private-assets 的本地标识 URL：private-assets://{path}
   *   3. 空字符串（表示无值）
   *
   * 父组件负责持久化裸 URL 到业务表；本组件内部通过 onUploaded 回调
   * 把完整 StorageObjectRef（含 bucket + path）传给父组件，父组件应至少
   * 保存 bucket + path 以便后续 cleanup / publish。
   */
  value: string;
  /**
   * 值变化回调。参数为兼容历史业务表字段的裸 URL 字符串或空字符串。
   *   - public-assets 上传成功：传入 publicUrl
   *   - private-assets 上传成功：传入 private-assets://{path} 本地标识
   *   - 移除：传入空字符串
   */
  onChange: (url: string) => void;
  /**
   * 上传成功后回调，传入完整 StorageObjectRef。
   * 父组件应至少保存 bucket + path（用于后续 cleanup / publish）。
   * public-assets 的 ref.publicUrl 不为 null；private-assets 的 ref.publicUrl
   * 为 null，需通过 fetchPrivatePreviewUrl 异步获取短期签名 URL 预览。
   */
  onUploaded?: (ref: StorageObjectRef) => void;
  /**
   * Storage 用途（必需）。客户端只提交 purpose，服务端决定 bucket /
   * category / MIME 白名单。禁止客户端自动决定公开性。
   *
   * 对应 storage-purpose.ts 中的合法 purpose 值：
   *   - "product-image"   产品展示图（public-assets）
   *   - "project-image"   项目展示图（public-assets）
   *   - "company-logo"    公司品牌资源（public-assets）
   *   - "homepage-image"  首页/OG/Banner（public-assets）
   *   - "catalog-draft"   Catalog 资产（private-assets，需 publish 流程）
   *   - "certificate-draft" 证书图片（private-assets，需 publish 流程）
   */
  purpose: StoragePurpose;
  label?: string;
  hint?: string;
  aspect?: "square" | "wide" | "logo";
}

const aspectClass: Record<NonNullable<ImageUploadProps["aspect"]>, string> = {
  square: "aspect-square",
  wide: "aspect-video",
  logo: "aspect-[3/1]",
};

/**
 * 为 private-assets 路径构造一个稳定的本地标识 URL。
 *
 * 这不是真实的可访问 URL —— 仅用于业务表字段的暂存标识，让父表单
 * 可以保存"这里有一张 private 图"的事实。父组件应在保存时通过
 * onUploaded 回调获取完整 StorageObjectRef，并触发 publish 流程后
 * 用真实 publicUrl 替换该值。
 *
 * 不得用此 URL 渲染 <img>；本组件通过 previewUrl（短期签名 URL）渲染。
 */
const PRIVATE_REF_PREFIX = "private-assets://";
function encodePrivateRef(path: string): string {
  return `${PRIVATE_REF_PREFIX}${path}`;
}
function decodePrivateRef(value: string): string | null {
  if (!value.startsWith(PRIVATE_REF_PREFIX)) return null;
  return value.slice(PRIVATE_REF_PREFIX.length);
}

export function ImageUpload({
  value,
  onChange,
  onUploaded,
  purpose,
  label,
  hint,
  aspect = "wide",
}: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  /**
   * 跟踪本次表单中新上传、尚未保存到 DB 的对象。
   * - handleFile 上传成功后保存完整 StorageObjectRef
   * - handleRemove 时若 newUploadedRef 非空 → 同步删除（reason: form_cancelled）
   * - 已持久化对象（来自 DB 的 value）→ newUploadedRef 为 null，handleRemove
   *   只清空字段，由父组件业务保存时入队 cleanup（reason: replaced | row_deleted）
   */
  const [newUploadedRef, setNewUploadedRef] = useState<StorageObjectRef | null>(null);

  // 渲染时根据 value 类型决定展示源：
  //   - private-assets://path → 异步获取短期签名 URL
  //   - 其他（http/https 或空）→ 直接作为 <img src>
  const privatePath = value ? decodePrivateRef(value) : null;

  // 通过 useEffect 触发签名 URL 加载，避免渲染期间副作用。
  // 仅在 privatePath 变化时触发；previewLoading 防止重复请求。
  useEffect(() => {
    if (!privatePath) {
      setPreviewUrl(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    fetchPrivatePreviewUrl(privatePath)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setPreviewUrl(result.previewUrl);
          setError(null);
        } else {
          setPreviewUrl(null);
          setError("预览签发失败，可重新上传或保存后查看");
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [privatePath]);

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

    // 新上传替换旧的未保存对象：先把旧的新上传对象加入 cleanup queue，
    // 不能依赖浏览器在保存成功后调用入队（用户可能直接关闭表单）。
    // 最终仍由服务器 dispatcher 重新检查引用后再删除，避免误删。
    const previousNewRef = newUploadedRef;
    if (previousNewRef) {
      // fire-and-forget 入队；失败时仅记录，不阻塞新上传
      void enqueueCleanupViaServerApi({
        bucket: previousNewRef.bucket,
        objectPath: previousNewRef.path,
        reason: "form_cancelled",
        sourceType: purpose,
      }).catch(() => {
        // 入队失败时由 storage_cleanup_queue dispatcher 后续通过
        // orphan_detected 路径兜底（read-only inventory 脚本可发现）
      });
    }

    setError(null);
    setUploading(true);
    const result = await uploadViaServerApi(file, purpose);
    setUploading(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    // private-assets 上传成功时 publicUrl 为 null —— 不得视为失败。
    const ref = result.data;
    // 跟踪本次新上传对象，供 handleRemove 同步删除
    setNewUploadedRef(ref);

    // public-assets → 直接传 publicUrl；private-assets → 传 private-assets://path
    // 形式的本地标识（父组件通过 onUploaded 获取真实 bucket+path）
    const valueForParent = ref.publicUrl ?? encodePrivateRef(ref.path);
    onChange(valueForParent);
    onUploaded?.(ref);

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

      if (del.ok) {
        // 删除成功：清空字段 + 清空错误 + 清空预览
        setNewUploadedRef(null);
        onChange("");
        setError(null);
        setPreviewUrl(null);
        return;
      }

      // 删除失败：尝试入队 cleanup，由 dispatcher 后续处理。
      // 必须根据入队结果设置不同的提示文案，不能无条件清空错误。
      const enq = await enqueueCleanupViaServerApi({
        bucket: newUploadedRef.bucket,
        objectPath: newUploadedRef.path,
        reason: "form_cancelled",
        sourceType: purpose,
      });

      if (enq.ok) {
        // 删除失败但入队成功 → 提示已加入待清理，仍清空字段（用户意图）
        setError(
          del.referenced
            ? "对象被引用，已加入待清理队列"
            : "对象删除失败，已加入待清理队列",
        );
      } else {
        // 删除失败且入队也失败 → 提示联系管理员，字段不清空以便用户重试
        setError("清理登记失败，请联系管理员");
        if (inputRef.current) inputRef.current.value = "";
        return;
      }

      setNewUploadedRef(null);
      onChange("");
      setPreviewUrl(null);
      return;
    }

    // 已持久化对象 → 只清空字段，业务保存时由父组件入队 cleanup
    // （reason: replaced 当用户重新上传时；reason: row_deleted 当业务行删除时）
    onChange("");
    setError(null);
    setPreviewUrl(null);
  }

  // 决定 <img src>：
  //   - private-assets://path → 使用 previewUrl（短期签名 URL）
  //   - 其他 URL → 直接使用 value
  //   - 空 → 占位
  const imgSrc = privatePath ? previewUrl : value;

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
          {imgSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imgSrc}
              alt="预览"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-gray-300">
              <ImageIcon className="h-8 w-8" />
            </div>
          )}
          {(uploading || removing || previewLoading) && (
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
            id={`upload-${purpose}`}
          />
          <div className="flex gap-2">
            <label
              htmlFor={`upload-${purpose}`}
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
