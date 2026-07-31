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
// 规则（与 docs/CODE_FINALIZATION_REPORT.md 与 .env.example 一致）：
// - NEXT_PUBLIC_SITE_URL 必须是站点根，不携带语言前缀（不附加 /en）。
// - 去除多余的尾部斜杠。
// - 缺失配置时回退到 http://localhost:3000，仅供本地开发使用。
// - 生产环境（NODE_ENV=production）下若 base 为 http 且非 localhost，
//   记录一次安全警告（不抛错以避免破坏构建），canonical/sitemap/OG 仍以该 base 输出，
//   实际 HTTPS 强制跳转交由 EdgeOne 控制台完成。
// - path 由调用方决定（通常是 localePath(locale, path)）；本函数不重复处理语言前缀。
export function siteUrl(path: string = ""): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  // 去除尾部斜杠
  let base = raw.replace(/\/+$/, "");
  // 防御 /en 或 /zh 被错误配置进 NEXT_PUBLIC_SITE_URL（仅剥离末尾一次，不破坏子路径）
  base = base.replace(/\/(en|zh)$/i, "");
  if (
    process.env.NODE_ENV === "production" &&
    base.startsWith("http://") &&
    !base.includes("localhost") &&
    !base.includes("127.0.0.1")
  ) {
    // 仅记录一次警告，避免在 ISR 重建时刷屏；不抛错。
    console.warn(
      "siteUrl: NEXT_PUBLIC_SITE_URL is http:// in production; HTTPS enforcement belongs to EdgeOne.",
    );
  }
  return `${base}${path}`;
}

// JSON-LD 会写入 <script type="application/ld+json"> 文本节点。
// 安全分析：
//   - 所有 5 处 dangerouslySetInnerHTML 调用点均使用本函数（KZQ-P1-004-c 审计）
//   - 数据源为 CMS 管理字段（产品名/描述/FAQ/公司信息），非用户直接可控
//   - 但管理员可编辑这些字段，因此必须防御通过 CMS 注入的 XSS
//
// 转义策略（遵循 OWASP JSON-LD 安全指南 + 防御深度）：
//   1. JSON.stringify 处理 JSON 语法转义（引号、反斜杠、换行等）
//   2. < → \u003c：阻止 </script> 闭合标签注入（核心防御）
//   3. > → \u003e：防御深度，阻止某些边缘上下文中的标签注入
//   4. & → \u0026：防御深度，阻止 HTML 实体解析
//   5. U+2028/U+2029 → \u2028/\u2029：JavaScript 行/段落分隔符，
//      ES2019 前 JSON.stringify 不转义这两个字符，可能导致 JS 解析中断
//
// 所有转义在 JSON 字符串中均合法，搜索引擎和浏览器正确解析。
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
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
