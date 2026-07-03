// ============================================================
// CMS 内容读取辅助函数
// 服务端使用：从 Supabase 读取 site_settings / homepage_content / page_content
// Demo 模式下返回 lib/mock-data.ts 中的对应数据
// 所有函数均做 fallback：数据库无内容或查询异常时返回 null，由调用方回退到默认文案
// 不让公开页面因为 CMS 表缺失、Supabase 临时异常、环境变量错误而直接崩溃
// ============================================================

import { isDemoMode } from "@/lib/demo";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  getMockSiteSettings,
  getMockHomepageContent,
  getMockPageContent,
} from "@/lib/mock-data";
import type {
  SiteSettings,
  HomepageContent,
  PageContent,
} from "@/types/database";

// 读取站点设置（单例）
export async function fetchSiteSettings(): Promise<SiteSettings | null> {
  if (isDemoMode()) {
    return getMockSiteSettings();
  }
  try {
    const supabase = createServerSupabaseClient();
    const { data } = await supabase
      .from("site_settings")
      .select("*")
      .limit(1)
      .maybeSingle();
    return (data as SiteSettings | null) || null;
  } catch (err) {
    console.error("fetchSiteSettings 查询失败:", err);
    return null;
  }
}

// 读取首页内容（取 is_active=true 的第一条；若无则返回 null）
export async function fetchHomepageContent(): Promise<HomepageContent | null> {
  if (isDemoMode()) {
    return getMockHomepageContent();
  }
  try {
    const supabase = createServerSupabaseClient();
    const { data } = await supabase
      .from("homepage_content")
      .select("*")
      .eq("is_active", true)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as HomepageContent | null) || null;
  } catch (err) {
    console.error("fetchHomepageContent 查询失败:", err);
    return null;
  }
}

// 按 page_key 读取页面内容
export async function fetchPageContent(
  pageKey: string
): Promise<PageContent | null> {
  if (isDemoMode()) {
    return getMockPageContent(pageKey);
  }
  try {
    const supabase = createServerSupabaseClient();
    const { data } = await supabase
      .from("page_content")
      .select("*")
      .eq("page_key", pageKey)
      .limit(1)
      .maybeSingle();
    return (data as PageContent | null) || null;
  } catch (err) {
    console.error(`fetchPageContent(${pageKey}) 查询失败:`, err);
    return null;
  }
}
