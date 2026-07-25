"use client";

import { useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import {
  uploadViaServerApi,
  type StorageObjectRef,
} from "@/lib/services/admin-storage-fetch";
import type { StoragePurpose } from "@/lib/services/storage-purpose";

export function FileUpload({
  purpose,
  onUploaded,
  onUploadedRef,
  label = "上传展示文件",
  accept = "application/pdf,image/jpeg,image/png,image/webp",
  hint = "PDF/JPG/PNG/WebP，最大 20MB；仅限展示版或水印版。",
}: {
  /**
   * Storage 用途（必需）。客户端只提交 purpose，服务端决定 bucket /
   * category / MIME 白名单。Catalog 资产默认 private-assets，需后续
   * publish 流程才能公开。
   */
  purpose: StoragePurpose;
  /**
   * 上传成功后回调，传入兼容历史字段的 { url, size, mimeType }。
   *   - public-assets：url 为公开 URL
   *   - private-assets：url 为 private-assets://{path} 本地标识
   *
   * 父组件若需要完整 bucket + path，请改用 onUploadedRef（未提供时
   * 通过 onUploaded 也能拿到基本信息）。
   */
  onUploaded: (value: { url: string; size: number; mimeType: string }) => void;
  /**
   * 上传成功后回调（完整版），传入 StorageObjectRef。
   * 父组件应至少保存 bucket + path 以便后续 cleanup / publish。
   */
  onUploadedRef?: (ref: StorageObjectRef) => void;
  label?: string;
  accept?: string;
  hint?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  async function upload(file?: File) {
    if (!file) return;
    setUploading(true);
    setError("");
    const result = await uploadViaServerApi(file, purpose);
    setUploading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // private-assets 上传成功时 publicUrl 为 null —— 不得视为失败。
    // 父组件通过 onUploadedRef 拿到完整 ref（含 bucket + path）。
    const ref = result.data;
    const url = ref.publicUrl ?? `private-assets://${ref.path}`;
    onUploaded({
      url,
      size: ref.size,
      mimeType: ref.mimeType,
    });
    onUploadedRef?.(ref);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div>
      <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(event) => upload(event.target.files?.[0])} />
      <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading} className="inline-flex h-10 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50">
        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
        {uploading ? "上传中…" : label}
      </button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      <p className="mt-1 text-[11px] text-gray-400">{hint}</p>
    </div>
  );
}
