"use client";

import { useEffect, useId, useRef, useState } from "react";
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

export type ImageOptimizationProfile = "hero-desktop" | "hero-mobile";

interface ImageUploadProps {
  value: string;
  onChange: (url: string) => void;
  onUploaded?: (ref: StorageObjectRef) => void;
  purpose: StoragePurpose;
  label?: string;
  hint?: string;
  aspect?: "square" | "wide" | "logo";
  optimizationProfile?: ImageOptimizationProfile;
  allowManualUrl?: boolean;
}

const aspectClass: Record<NonNullable<ImageUploadProps["aspect"]>, string> = {
  square: "aspect-square",
  wide: "aspect-video",
  logo: "aspect-[3/1]",
};

const MAX_SERVER_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_SELECTED_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_HOMEPAGE_IMAGE_BYTES = 700 * 1024;
const SUPPORTED_OPTIMIZATION_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type OptimizationConfig = {
  maxWidth: number;
  maxHeight: number;
  targetBytes: number;
  hardMaxBytes: number;
  qualities: readonly number[];
};

const HERO_OPTIMIZATION: Record<
  ImageOptimizationProfile | "homepage",
  OptimizationConfig
> = {
  "hero-desktop": {
    maxWidth: 1920,
    maxHeight: 1080,
    targetBytes: 450 * 1024,
    hardMaxBytes: MAX_HOMEPAGE_IMAGE_BYTES,
    qualities: [0.82, 0.76, 0.7, 0.64, 0.58],
  },
  "hero-mobile": {
    maxWidth: 1080,
    maxHeight: 1440,
    targetBytes: 300 * 1024,
    hardMaxBytes: MAX_HOMEPAGE_IMAGE_BYTES,
    qualities: [0.82, 0.76, 0.7, 0.64, 0.58],
  },
  homepage: {
    maxWidth: 1920,
    maxHeight: 1920,
    targetBytes: 500 * 1024,
    hardMaxBytes: MAX_HOMEPAGE_IMAGE_BYTES,
    qualities: [0.82, 0.76, 0.7, 0.64, 0.58],
  },
};

function webpFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return `${dot > 0 ? filename.slice(0, dot) : filename}.webp`;
}

function canvasToWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
}

async function optimizeToWebp(
  file: File,
  config: OptimizationConfig,
): Promise<File> {
  if (!SUPPORTED_OPTIMIZATION_MIME_TYPES.has(file.type)) {
    throw new Error("请选择 JPG、PNG 或 WebP 图片");
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const initialScale = Math.min(
      1,
      config.maxWidth / bitmap.width,
      config.maxHeight / bitmap.height,
    );
    let width = Math.max(1, Math.round(bitmap.width * initialScale));
    let height = Math.max(1, Math.round(bitmap.height * initialScale));
    let smallest: Blob | null = null;

    for (let pass = 0; pass < 4; pass += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error("图片处理失败，请重新选择图片");
      context.drawImage(bitmap, 0, 0, width, height);

      for (const quality of config.qualities) {
        const blob = await canvasToWebp(canvas, quality);
        if (!blob || blob.size === 0) continue;
        if (!smallest || blob.size < smallest.size) smallest = blob;
        if (blob.size <= config.targetBytes) {
          return new File([blob], webpFilename(file.name), {
            type: "image/webp",
            lastModified: file.lastModified,
          });
        }
      }

      width = Math.max(1, Math.round(width * 0.86));
      height = Math.max(1, Math.round(height * 0.86));
    }

    if (smallest && smallest.size <= config.hardMaxBytes) {
      return new File([smallest], webpFilename(file.name), {
        type: "image/webp",
        lastModified: file.lastModified,
      });
    }
    throw new Error("图片优化后仍然过大，请降低原图分辨率后重试");
  } finally {
    bitmap?.close();
  }
}

async function prepareImageForServerUpload(
  file: File,
  purpose: StoragePurpose,
  optimizationProfile?: ImageOptimizationProfile,
): Promise<File> {
  if (purpose === "homepage-image") {
    return optimizeToWebp(
      file,
      HERO_OPTIMIZATION[optimizationProfile ?? "homepage"],
    );
  }
  if (file.size <= MAX_SERVER_IMAGE_BYTES) return file;
  return optimizeToWebp(file, {
    maxWidth: 2560,
    maxHeight: 2560,
    targetBytes: Math.floor(3.5 * 1024 * 1024),
    hardMaxBytes: MAX_SERVER_IMAGE_BYTES,
    qualities: [0.88, 0.82, 0.76, 0.7],
  });
}

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
  optimizationProfile,
  allowManualUrl = true,
}: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const reactId = useId();
  const inputId = `upload-${purpose}-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [newUploadedRef, setNewUploadedRef] = useState<StorageObjectRef | null>(null);

  const privatePath = value ? decodePrivateRef(value) : null;

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

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;
    if (!selectedFile.type.startsWith("image/")) {
      setError("请选择图片文件");
      return;
    }
    if (selectedFile.size > MAX_SELECTED_IMAGE_BYTES) {
      setError("图片大小不能超过 5MB");
      return;
    }

    const previousNewRef = newUploadedRef;
    if (previousNewRef) {
      void enqueueCleanupViaServerApi({
        bucket: previousNewRef.bucket,
        objectPath: previousNewRef.path,
        reason: "form_cancelled",
        sourceType: purpose,
      });
    }

    setError(null);
    setUploading(true);

    let file: File;
    try {
      file = await prepareImageForServerUpload(
        selectedFile,
        purpose,
        optimizationProfile,
      );
    } catch (uploadPreparationError) {
      setUploading(false);
      setError(
        uploadPreparationError instanceof Error
          ? uploadPreparationError.message
          : "图片处理失败，请重新选择图片",
      );
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    const result = await uploadViaServerApi(file, purpose);
    setUploading(false);
    if (!result.ok) {
      setError(result.error);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    const ref = result.data;
    setNewUploadedRef(ref);
    onChange(ref.publicUrl ?? encodePrivateRef(ref.path));
    onUploaded?.(ref);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleRemove() {
    if (newUploadedRef) {
      setRemoving(true);
      const deleted = await deleteViaServerApi(
        newUploadedRef.bucket,
        newUploadedRef.path,
      );
      setRemoving(false);
      if (!deleted.ok) {
        const queued = await enqueueCleanupViaServerApi({
          bucket: newUploadedRef.bucket,
          objectPath: newUploadedRef.path,
          reason: "form_cancelled",
          sourceType: purpose,
        });
        if (!queued.ok) {
          setError("清理登记失败，请联系管理员");
          return;
        }
        setError(
          deleted.referenced
            ? "对象被引用，已加入待清理队列"
            : "对象删除失败，已加入待清理队列",
        );
      } else {
        setError(null);
      }
      setNewUploadedRef(null);
      onChange("");
      setPreviewUrl(null);
      return;
    }

    onChange("");
    setError(null);
    setPreviewUrl(null);
  }

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
            aspectClass[aspect],
          )}
        >
          {imgSrc ? (
            <img src={imgSrc} alt="预览" className="h-full w-full object-cover" />
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
            accept="image/jpeg,image/png,image/webp"
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
                uploading && "pointer-events-none opacity-50",
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
          {allowManualUrl && value && (
            <input
              type="text"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              className="h-9 w-full rounded-md border border-gray-200 bg-white px-2.5 text-xs text-gray-600 outline-none focus:border-steel"
              placeholder="或手动填写图片 URL"
            />
          )}
        </div>
      </div>
    </div>
  );
}
