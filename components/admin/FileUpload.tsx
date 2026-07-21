"use client";

import { useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { uploadPublicFile } from "@/lib/supabase/storage";

export function FileUpload({
  folder,
  onUploaded,
  label = "上传展示文件",
  accept = "application/pdf,image/jpeg,image/png,image/webp",
  hint = "PDF/JPG/PNG/WebP，最大 20MB；仅限展示版或水印版。",
}: {
  folder: string;
  onUploaded: (value: { url: string; size: number; mimeType: string }) => void;
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
    const result = await uploadPublicFile(file, folder);
    setUploading(false);
    if (!result.url) {
      setError(result.error || "上传失败");
      return;
    }
    onUploaded({ url: result.url, size: file.size, mimeType: file.type });
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
