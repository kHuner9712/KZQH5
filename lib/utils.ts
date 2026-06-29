import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// 合并 tailwind class
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 生成 slug（中英文混合：中文转拼音简化为移除，英文小写连字符）
// 由于不引入拼音库，中文标题会保留中文并以连字符分隔；推荐后台手动优化为英文 slug
export function generateSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// 格式化日期
export function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// 站点绝对 URL
export function siteUrl(path: string = ""): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  return `${base.replace(/\/$/, "")}${path}`;
}
