import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// 合并 tailwind class
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 生成 slug：只允许小写字母、数字和连字符
// - 英文标题：转小写 + 空格/下划线转连字符 + 去除非法字符
// - 中文标题或无可用英文：fallback 为 product-时间戳，避免与表单校验冲突
// 表单校验规则：/^[a-z0-9-]+$/
export function generateSlug(text: string): string {
  const cleaned = text
    .trim()
    .toLowerCase()
    // 移除中文字符（不引入拼音库，无法可靠转换）
    .replace(/[\u4e00-\u9fa5]+/g, " ")
    // 空格/下划线转连字符
    .replace(/[\s_]+/g, "-")
    // 仅保留小写字母、数字、连字符
    .replace(/[^a-z0-9-]/g, "")
    // 合并连续连字符
    .replace(/-+/g, "-")
    // 去除首尾连字符
    .replace(/^-+|-+$/g, "");

  // 如果清理后为空（例如纯中文标题），fallback 为 product-时间戳
  if (!cleaned) {
    return `product-${Date.now()}`;
  }
  return cleaned;
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

// JSON-LD 会写入 <script> 文本节点；转义小于号可阻止 CMS 文本闭合 script 标签。
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// 搜索关键词清洗：用于安全拼入 Supabase PostgREST .or() 表达式
// - 限制最大长度（80 字符）
// - trim
// - 移除会破坏 PostgREST filter 表达式的字符：% , . ( ) 换行 等
// - 返回清洗后的搜索词；若清洗后为空则返回空字符串（调用方据此跳过 .or()）
export function normalizeSearchTerm(input: string | undefined | null): string {
  if (!input) return "";
  const trimmed = input.trim();
  if (!trimmed) return "";
  // 限制最大长度
  const sliced = trimmed.slice(0, 80);
  // 移除会破坏 PostgREST .or() 表达式的字符：
  //   %  -> ilike 通配符，避免注入额外通配
  //   ,  -> .or() 字段分隔符
  //   .  -> 操作符分隔（如 ilike.）
  //   ( ) -> 分组符号
  //   :  -> 操作符分隔
  //   换行/制表符
  const cleaned = sliced.replace(/[%`,().:\\\n\r\t]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned;
}
