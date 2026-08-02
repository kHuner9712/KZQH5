/**
 * Homepage content admin API.
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isDemoMode } from "@/lib/demo";
import {
  adminWriteError,
  requireAdminRead,
  requireAdminWrite,
} from "@/lib/services/admin-write-boundary";
import type { AdminWriteErrorCode } from "@/lib/services/admin-write-boundary";
import {
  getHomepageContent,
  saveHomepageContentV2,
} from "@/lib/services/homepage-content-write";
import { processRemovedHomepageHeroAssets } from "@/lib/services/homepage-hero-assets";
import { validateHomeFeatureArray } from "@/lib/validation/jsonb-fields";
import { validateHomeHeroSlideArray } from "@/lib/validation/home-hero-slides";
import type { HomeHeroSlide } from "@/types/homepage";

const MAX_BODY = 256 * 1024;

function statusForCode(code: AdminWriteErrorCode): number {
  switch (code) {
    case "ADMIN_WRITE_BAD_REQUEST":
      return 400;
    case "ADMIN_WRITE_FORBIDDEN_ORIGIN":
    case "ADMIN_WRITE_FORBIDDEN_ROLE":
    case "ADMIN_WRITE_DEMO":
      return 403;
    case "ADMIN_WRITE_UNAUTHORIZED":
      return 401;
    case "ADMIN_WRITE_PAYLOAD_TOO_LARGE":
      return 413;
    case "ADMIN_WRITE_UNSUPPORTED_MEDIA":
      return 415;
    case "ADMIN_WRITE_CONFLICT":
      return 409;
    default:
      return 500;
  }
}

export async function GET(request: NextRequest) {
  const guard = await requireAdminRead(request, { minimumRole: "editor" });
  if (!guard.ok) return guard.response;

  if (isDemoMode()) {
    return NextResponse.json({ success: true, demo: true, content: null });
  }

  const result = await getHomepageContent(guard.client);
  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code));
  }
  return NextResponse.json({ success: true, content: result.data });
}

export async function POST(request: NextRequest) {
  const guard = await requireAdminWrite<Record<string, unknown>>(request, {
    maxBytes: MAX_BODY,
    minimumRole: "admin",
  });
  if (!guard.ok) return guard.response;

  const body = guard.body;
  const rawPayload = body.payload;
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }
  const payload = rawPayload as Record<string, unknown>;

  const stringOrNull = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  };

  const id = typeof body.id === "string" && body.id ? body.id : null;
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" && body.expectedUpdatedAt
      ? body.expectedUpdatedAt
      : null;

  if (isDemoMode()) {
    return NextResponse.json({
      success: true,
      demo: true,
      id: id ?? `demo-${Date.now()}`,
      updatedAt: new Date().toISOString(),
    });
  }

  const featuresCn = validateHomeFeatureArray(
    "features_cn",
    payload.features_cn,
    20,
  );
  const featuresEn = validateHomeFeatureArray(
    "features_en",
    payload.features_en,
    20,
  );
  const heroSlides = validateHomeHeroSlideArray(payload.hero_slides, 5);
  if (!featuresCn.ok || !featuresEn.ok || !heroSlides.ok) {
    return adminWriteError("ADMIN_WRITE_BAD_REQUEST", 400);
  }

  let previousSlides: HomeHeroSlide[] = [];
  if (id) {
    const previous = await getHomepageContent(guard.client);
    if (!previous.ok) {
      return adminWriteError(previous.code, statusForCode(previous.code));
    }
    if (previous.data?.id === id && Array.isArray(previous.data.hero_slides)) {
      previousSlides = previous.data.hero_slides as HomeHeroSlide[];
    }
  }

  const result = await saveHomepageContentV2(
    guard.client,
    {
      id,
      expectedUpdatedAt,
      payload: {
        hero_eyebrow_cn: stringOrNull(payload.hero_eyebrow_cn),
        hero_eyebrow_en: stringOrNull(payload.hero_eyebrow_en),
        hero_title_cn: stringOrNull(payload.hero_title_cn),
        hero_title_en: stringOrNull(payload.hero_title_en),
        hero_highlight_cn: stringOrNull(payload.hero_highlight_cn),
        hero_highlight_en: stringOrNull(payload.hero_highlight_en),
        hero_description_cn: stringOrNull(payload.hero_description_cn),
        hero_description_en: stringOrNull(payload.hero_description_en),
        primary_cta_text_cn: stringOrNull(payload.primary_cta_text_cn),
        primary_cta_text_en: stringOrNull(payload.primary_cta_text_en),
        secondary_cta_text_cn: stringOrNull(payload.secondary_cta_text_cn),
        secondary_cta_text_en: stringOrNull(payload.secondary_cta_text_en),
        hero_slides: heroSlides.value,
        feature_section_title_cn: stringOrNull(payload.feature_section_title_cn),
        feature_section_title_en: stringOrNull(payload.feature_section_title_en),
        feature_section_subtitle_cn: stringOrNull(
          payload.feature_section_subtitle_cn,
        ),
        feature_section_subtitle_en: stringOrNull(
          payload.feature_section_subtitle_en,
        ),
        features_cn: featuresCn.value,
        features_en: featuresEn.value,
        category_section_title_cn: stringOrNull(
          payload.category_section_title_cn,
        ),
        category_section_title_en: stringOrNull(
          payload.category_section_title_en,
        ),
        category_section_subtitle_cn: stringOrNull(
          payload.category_section_subtitle_cn,
        ),
        category_section_subtitle_en: stringOrNull(
          payload.category_section_subtitle_en,
        ),
        featured_products_title_cn: stringOrNull(
          payload.featured_products_title_cn,
        ),
        featured_products_title_en: stringOrNull(
          payload.featured_products_title_en,
        ),
        featured_products_subtitle_cn: stringOrNull(
          payload.featured_products_subtitle_cn,
        ),
        featured_products_subtitle_en: stringOrNull(
          payload.featured_products_subtitle_en,
        ),
        certificates_section_title_cn: stringOrNull(
          payload.certificates_section_title_cn,
        ),
        certificates_section_title_en: stringOrNull(
          payload.certificates_section_title_en,
        ),
        certificates_note_cn: stringOrNull(payload.certificates_note_cn),
        certificates_note_en: stringOrNull(payload.certificates_note_en),
        projects_section_title_cn: stringOrNull(payload.projects_section_title_cn),
        projects_section_title_en: stringOrNull(payload.projects_section_title_en),
        projects_section_subtitle_cn: stringOrNull(
          payload.projects_section_subtitle_cn,
        ),
        projects_section_subtitle_en: stringOrNull(
          payload.projects_section_subtitle_en,
        ),
        bottom_cta_eyebrow_cn: stringOrNull(payload.bottom_cta_eyebrow_cn),
        bottom_cta_eyebrow_en: stringOrNull(payload.bottom_cta_eyebrow_en),
        bottom_cta_title_cn: stringOrNull(payload.bottom_cta_title_cn),
        bottom_cta_title_en: stringOrNull(payload.bottom_cta_title_en),
        bottom_cta_description_cn: stringOrNull(
          payload.bottom_cta_description_cn,
        ),
        bottom_cta_description_en: stringOrNull(
          payload.bottom_cta_description_en,
        ),
        bottom_cta_button_text_cn: stringOrNull(
          payload.bottom_cta_button_text_cn,
        ),
        bottom_cta_button_text_en: stringOrNull(
          payload.bottom_cta_button_text_en,
        ),
        is_active:
          typeof payload.is_active === "boolean" ? payload.is_active : true,
      },
    },
    {
      id: guard.user.id,
      email: guard.user.email,
      role: guard.profile.role,
    },
  );

  if (!result.ok) {
    return adminWriteError(result.code, statusForCode(result.code));
  }

  const cleanup = await processRemovedHomepageHeroAssets({
    client: guard.client,
    previousSlides,
    nextSlides: heroSlides.value,
    sourceId: result.data.id,
    actor: { id: guard.user.id, role: guard.profile.role },
  });
  if (cleanup.deferred > 0) {
    console.warn("HERO_CLEANUP_DEFERRED", cleanup);
  }

  revalidatePath("/admin", "layout");
  revalidatePath("/", "page");
  revalidatePath("/en", "page");
  return NextResponse.json({
    success: true,
    id: result.data.id,
    updatedAt: result.data.updatedAt,
    cleanup,
  });
}
