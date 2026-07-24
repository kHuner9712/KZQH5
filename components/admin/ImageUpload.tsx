"use client";

import { useRef, useState } from "react";
import { uploadViaServerApi, deleteViaServerApi } from "@/lib/services/admin-storage-fetch";
import { cn } from "@/lib/utils";
import { Upload, X, Image as ImageIcon, Loader2 } from "lucide-react";

interface ImageUploadProps {
  value: string;
  onChange: (url: string) => void;
  folder: string;
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
  folder,
  label,
  hint,
  aspect = "wide",
}: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const result = await uploadViaServerApi(file, folder);
    setUploading(false);

    if (!result.ok || !result.data.publicUrl) {
      setError(result.ok ? "上传失败" : result.error);
      return;
    }
    onChange(result.data.publicUrl);
    // 重置 input 以便相同文件可再次选择
    if (inputRef.current) inputRef.current.value = "";
  }

  function handleRemove() {
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
          {uploading && (
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
            id={`upload-${folder}`}
          />
          <div className="flex gap-2">
            <label
              htmlFor={`upload-${folder}`}
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
                className="inline-flex h-9 items-center gap-1 rounded-md px-2 text-xs text-red-600 hover:bg-red-50"
              >
                <X className="h-3.5 w-3.5" /> 移除
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
