import { createBrowserSupabaseClient } from "./client";

// 上传公开图片到 public-assets bucket
// 仅在后台管理客户端调用，需要管理员登录态（RLS 校验）
export async function uploadPublicImage(
  file: File,
  folder: string
): Promise<{ url: string | null; error: string | null }> {
  const supabase = createBrowserSupabaseClient();

  const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
  const fileName = `${folder}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.${ext}`;

  const { error } = await supabase.storage
    .from("public-assets")
    .upload(fileName, file, {
      cacheControl: "3600",
      upsert: false,
    });

  if (error) {
    return { url: null, error: error.message };
  }

  const { data } = supabase.storage
    .from("public-assets")
    .getPublicUrl(fileName);

  return { url: data.publicUrl, error: null };
}

// 上传公开展示文件。调用方必须先确认文件为展示版或水印版；内部源文件不得上传。
export async function uploadPublicFile(
  file: File,
  folder: string
): Promise<{ url: string | null; error: string | null }> {
  const allowed = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
  if (!allowed.has(file.type)) return { url: null, error: "仅支持 PDF、JPG、PNG 或 WebP 展示文件" };
  if (file.size > 20 * 1024 * 1024) return { url: null, error: "文件大小不能超过 20MB" };
  const supabase = createBrowserSupabaseClient();
  const ext = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const fileName = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { error } = await supabase.storage.from("public-assets").upload(fileName, file, { cacheControl: "3600", upsert: false, contentType: file.type });
  if (error) return { url: null, error: error.message };
  const { data } = supabase.storage.from("public-assets").getPublicUrl(fileName);
  return { url: data.publicUrl, error: null };
}
