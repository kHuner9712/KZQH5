import { isDemoMode } from "@/lib/demo";
import { mockCompany } from "@/lib/mock-data";
import { fetchSiteSettings } from "@/lib/queries/cms";
import { sanitizeCompany } from "@/lib/content/placeholder-detection";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import {
  PublicDataUnavailableError,
  logPublicDataFailure,
} from "@/lib/repositories/public-types";
import { COMPANY_PROFILE_FIELDS } from "@/lib/repositories/public-fields";
import type { CompanyProfile, SiteSettings } from "@/types/database";

/**
 * 获取公开站点外壳数据（公司信息 + 站点设置）。
 *
 * Work Package F contract:
 *   - Demo 模式 → mock 数据
 *   - 任一查询基础设施失败 → 抛 PublicDataUnavailableError
 *     (上层 renderPublicPage 渲染 fallback)
 *   - 数据存在但被 sanitize 过滤为占位 → 返回 null 字段
 *     (合法空数据，不算错误)
 *
 * 不再 swallow 错误并返回 { company: null, siteSettings: null } —
 * 那会让 Supabase 全局故障看起来像 "未配置公司信息"，无法在
 * 监控中区分。
 */
export async function getPublicSiteShellData(): Promise<{
  company: CompanyProfile | null;
  siteSettings: SiteSettings | null;
}> {
  if (isDemoMode()) {
    return {
      company: sanitizeCompany(mockCompany),
      siteSettings: await fetchSiteSettings(),
    };
  }

  try {
    const supabase = createPublicSupabaseClient();
    // Promise.all 任一失败都会抛出 — 由外层 try/catch 捕获并转换。
    // 注意：fetchSiteSettings 自身已用 PublicDataUnavailableError 包装
    // 错误，所以这里只处理 company_profile 的错误。
    const [companyResult, siteSettings] = await Promise.all([
      supabase
        .from("company_profile")
        .select(COMPANY_PROFILE_FIELDS)
        .limit(1)
        .maybeSingle(),
      fetchSiteSettings(),
    ]);
    if (companyResult.error) {
      logPublicDataFailure("PUBLIC_DATA_READ_FAILED", companyResult.error);
      throw new PublicDataUnavailableError("PUBLIC_DATA_READ_FAILED", {
        cause: companyResult.error,
      });
    }
    return {
      company: sanitizeCompany(
        (companyResult.data as CompanyProfile | null) || null,
      ),
      siteSettings,
    };
  } catch (error) {
    if (PublicDataUnavailableError.is(error)) throw error;
    logPublicDataFailure("PUBLIC_DATA_READ_EXCEPTION", error);
    throw new PublicDataUnavailableError("PUBLIC_DATA_READ_EXCEPTION", {
      cause: error,
    });
  }
}
