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
