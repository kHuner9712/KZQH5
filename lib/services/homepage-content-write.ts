import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { HomeHeroSlide } from "@/types/homepage";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import type { ContentWriteResult, AdminActor } from "@/lib/services/admin-content-write";

export { getHomepageContent } from "@/lib/services/admin-content-write";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function extractErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: string }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function classifyError(code: string | undefined): AdminWriteErrorCode {
  if (!code) return "ADMIN_WRITE_FAILED";
  const normalized = code.toUpperCase();
  if (
    normalized === "22004" ||
    normalized === "P0002" ||
    normalized === "23502" ||
    normalized === "23503" ||
    normalized === "22P02"
  ) {
    return "ADMIN_WRITE_BAD_REQUEST";
  }
  if (
    normalized === "40P01" ||
    normalized === "40001" ||
    normalized === "23505"
  ) {
    return "ADMIN_WRITE_CONFLICT";
  }
  return "ADMIN_WRITE_FAILED";
}

export interface HomepageContentV2Payload {
  hero_eyebrow_cn: string | null;
  hero_eyebrow_en: string | null;
  hero_title_cn: string | null;
  hero_title_en: string | null;
  hero_highlight_cn: string | null;
  hero_highlight_en: string | null;
  hero_description_cn: string | null;
  hero_description_en: string | null;
  primary_cta_text_cn: string | null;
  primary_cta_text_en: string | null;
  secondary_cta_text_cn: string | null;
  secondary_cta_text_en: string | null;
  hero_slides: HomeHeroSlide[];
  feature_section_title_cn: string | null;
  feature_section_title_en: string | null;
  feature_section_subtitle_cn: string | null;
  feature_section_subtitle_en: string | null;
  features_cn: unknown;
  features_en: unknown;
  category_section_title_cn: string | null;
  category_section_title_en: string | null;
  category_section_subtitle_cn: string | null;
  category_section_subtitle_en: string | null;
  featured_products_title_cn: string | null;
  featured_products_title_en: string | null;
  featured_products_subtitle_cn: string | null;
  featured_products_subtitle_en: string | null;
  certificates_section_title_cn: string | null;
  certificates_section_title_en: string | null;
  certificates_note_cn: string | null;
  certificates_note_en: string | null;
  projects_section_title_cn: string | null;
  projects_section_title_en: string | null;
  projects_section_subtitle_cn: string | null;
  projects_section_subtitle_en: string | null;
  bottom_cta_eyebrow_cn: string | null;
  bottom_cta_eyebrow_en: string | null;
  bottom_cta_title_cn: string | null;
  bottom_cta_title_en: string | null;
  bottom_cta_description_cn: string | null;
  bottom_cta_description_en: string | null;
  bottom_cta_button_text_cn: string | null;
  bottom_cta_button_text_en: string | null;
  is_active: boolean;
}

export async function saveHomepageContentV2(
  client: SupabaseClient<Database>,
  input: {
    id?: string | null;
    payload: HomepageContentV2Payload;
    expectedUpdatedAt?: string | null;
  },
  actor: AdminActor,
): Promise<ContentWriteResult<{ id: string; updatedAt: string }>> {
  if (input.id) {
    if (!UUID_RE.test(input.id) || !input.expectedUpdatedAt) {
      return { ok: false, code: "ADMIN_WRITE_BAD_REQUEST" };
    }
  }

  try {
    const { data, error } = await client.rpc("save_homepage_content_with_audit", {
      p_id: input.id ?? null,
      p_payload: {
        ...input.payload,
        features_cn: input.payload.features_cn ?? [],
        features_en: input.payload.features_en ?? [],
        hero_slides: input.payload.hero_slides ?? [],
      },
      p_expected_updated_at: input.expectedUpdatedAt ?? null,
      p_actor_id: actor.id,
      p_actor_email: actor.email ?? null,
      p_actor_role: actor.role ?? null,
    });

    if (error) {
      const code = classifyError(extractErrorCode(error));
      console.error("HOMEPAGE_SAVE_FAILED", { code });
      return { ok: false, code };
    }

    const result = data as { id?: string; updated_at?: string } | null;
    if (!result?.id || !result.updated_at) {
      return { ok: false, code: "ADMIN_WRITE_FAILED" };
    }
    return {
      ok: true,
      data: { id: result.id, updatedAt: result.updated_at },
    };
  } catch (error) {
    const code = classifyError(extractErrorCode(error));
    console.error("HOMEPAGE_SAVE_EXCEPTION", { code });
    return { ok: false, code };
  }
}
