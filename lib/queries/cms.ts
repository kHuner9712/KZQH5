// ============================================================
// CMS 内容读取辅助函数
// 服务端使用：从 Supabase 读取 site_settings / homepage_content / page_content
// Demo 模式下返回 lib/mock-data.ts 中的对应数据
//
// Work Package F contract:
//   - 合法空数据 (no rows / not configured) → return null
//   - 基础设施失败 (Supabase error / network / env) → throw
//     PublicDataUnavailableError so renderPublicPage renders the
//     "data temporarily unavailable" fallback and the failure is
//     visible in server logs (fixed coarse code only).
//   - React `cache()` wraps each singleton so a single RSC render
//     that calls fetchSiteSettings() from layout + page + metadata
//     only hits the DB once.
//   - 显式字段列表替代 select("*") — 新增 DB 字段不会自动暴露
//     到 RSC payload，并减小传输体积。
// ============================================================

import { cache } from "react";
import { isDemoMode } from "@/lib/demo";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import {
  getMockSiteSettings,
  getMockHomepageContent,
  getMockPageContent,
} from "@/lib/mock-data";
import {
  PublicDataUnavailableError,
  logPublicDataFailure,
} from "@/lib/repositories/public-types";
import {
  SITE_SETTINGS_FIELDS,
  HOMEPAGE_CONTENT_FIELDS,
  PAGE_CONTENT_FIELDS,
} from "@/lib/repositories/public-fields";
import type {
  SiteSettings,
  HomepageContent,
  PageContent,
} from "@/types/database";

/**
 * 读取站点设置（单例）。
 *
 * 行为：
 *   - Demo 模式 → mock 数据
 *   - 无数据 (no rows) → null（合法空数据）
 *   - 基础设施失败 → 抛 PublicDataUnavailableError
 *
 * React cache() 保证单次 RSC 渲染中 layout + page + metadata
 * 多次调用只命中数据库一次。
 */
export const fetchSiteSettings = cache(
  async function fetchSiteSettings(): Promise<SiteSettings | null> {
    if (isDemoMode()) {
      return getMockSiteSettings();
    }
    try {
      const supabase = createPublicSupabaseClient();
      const { data, error } = await supabase
        .from("site_settings")
        .select(SITE_SETTINGS_FIELDS)
        .limit(1)
        .maybeSingle();
      if (error) {
        logPublicDataFailure("PUBLIC_DATA_READ_FAILED", error);
        throw new PublicDataUnavailableError("PUBLIC_DATA_READ_FAILED", {
          cause: error,
        });
      }
      return (data as SiteSettings | null) || null;
    } catch (error) {
      if (PublicDataUnavailableError.is(error)) throw error;
      logPublicDataFailure("PUBLIC_DATA_READ_EXCEPTION", error);
      throw new PublicDataUnavailableError("PUBLIC_DATA_READ_EXCEPTION", {
        cause: error,
      });
    }
  },
);

/**
 * 读取首页内容（取 is_active=true 的第一条）。
 *
 * 无活跃行 → null（合法空数据，页面使用默认文案）。
 * 基础设施失败 → 抛 PublicDataUnavailableError。
 */
export const fetchHomepageContent = cache(
  async function fetchHomepageContent(): Promise<HomepageContent | null> {
    if (isDemoMode()) {
      return getMockHomepageContent();
    }
    try {
      const supabase = createPublicSupabaseClient();
      const { data, error } = await supabase
        .from("homepage_content")
        .select(HOMEPAGE_CONTENT_FIELDS)
        .eq("is_active", true)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        logPublicDataFailure("PUBLIC_DATA_READ_FAILED", error);
        throw new PublicDataUnavailableError("PUBLIC_DATA_READ_FAILED", {
          cause: error,
        });
      }
      return (data as HomepageContent | null) || null;
    } catch (error) {
      if (PublicDataUnavailableError.is(error)) throw error;
      logPublicDataFailure("PUBLIC_DATA_READ_EXCEPTION", error);
      throw new PublicDataUnavailableError("PUBLIC_DATA_READ_EXCEPTION", {
        cause: error,
      });
    }
  },
);

/**
 * 按 page_key 读取页面内容。
 *
 * 无对应行 → null（合法空数据，页面使用默认文案）。
 * 基础设施失败 → 抛 PublicDataUnavailableError。
 *
 * Note: 不使用全局 cache() — page_key 是参数，需要 per-key 缓存。
 * React cache() 自动按参数元组缓存，所以这是安全的。
 */
export const fetchPageContent = cache(
  async function fetchPageContent(
    pageKey: string,
  ): Promise<PageContent | null> {
    if (isDemoMode()) {
      return getMockPageContent(pageKey);
    }
    try {
      const supabase = createPublicSupabaseClient();
      const { data, error } = await supabase
        .from("page_content")
        .select(PAGE_CONTENT_FIELDS)
        .eq("page_key", pageKey)
        .limit(1)
        .maybeSingle();
      if (error) {
        logPublicDataFailure("PUBLIC_DATA_READ_FAILED", error);
        throw new PublicDataUnavailableError("PUBLIC_DATA_READ_FAILED", {
          cause: error,
        });
      }
      return (data as PageContent | null) || null;
    } catch (error) {
      if (PublicDataUnavailableError.is(error)) throw error;
      logPublicDataFailure("PUBLIC_DATA_READ_EXCEPTION", error);
      throw new PublicDataUnavailableError("PUBLIC_DATA_READ_EXCEPTION", {
        cause: error,
      });
    }
  },
);
