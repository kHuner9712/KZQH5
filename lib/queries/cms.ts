// ============================================================
// CMS 内容读取辅助函数
// 服务端使用：从 Supabase 读取 site_settings / homepage_content / page_content
// Demo 模式下返回 lib/mock-data.ts 中的对应数据
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

const HOMEPAGE_CONTENT_V2_FIELDS = [
  HOMEPAGE_CONTENT_FIELDS,
  "hero_slides",
  "category_section_title_en",
  "category_section_subtitle_en",
  "featured_products_title_en",
  "featured_products_subtitle_en",
  "certificates_section_title_cn",
  "certificates_section_title_en",
  "certificates_note_cn",
  "certificates_note_en",
  "projects_section_title_cn",
  "projects_section_title_en",
  "projects_section_subtitle_cn",
  "projects_section_subtitle_en",
  "bottom_cta_eyebrow_cn",
  "bottom_cta_eyebrow_en",
  "bottom_cta_button_text_cn",
  "bottom_cta_button_text_en",
].join(", ");

export const fetchSiteSettings = cache(
  async function fetchSiteSettings(): Promise<SiteSettings | null> {
    if (isDemoMode()) return getMockSiteSettings();
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

export const fetchHomepageContent = cache(
  async function fetchHomepageContent(): Promise<HomepageContent | null> {
    if (isDemoMode()) return getMockHomepageContent();
    try {
      const supabase = createPublicSupabaseClient();
      const { data, error } = await supabase
        .from("homepage_content")
        .select(HOMEPAGE_CONTENT_V2_FIELDS)
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

export const fetchPageContent = cache(
  async function fetchPageContent(
    pageKey: string,
  ): Promise<PageContent | null> {
    if (isDemoMode()) return getMockPageContent(pageKey);
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
