import type { HomeHeroSlide } from "./homepage";

declare module "./database" {
  interface HomepageContent {
    hero_slides?: HomeHeroSlide[] | null;
    category_section_title_en?: string | null;
    category_section_subtitle_en?: string | null;
    featured_products_title_en?: string | null;
    featured_products_subtitle_en?: string | null;
    certificates_section_title_cn?: string | null;
    certificates_section_title_en?: string | null;
    certificates_note_cn?: string | null;
    certificates_note_en?: string | null;
    projects_section_title_cn?: string | null;
    projects_section_title_en?: string | null;
    projects_section_subtitle_cn?: string | null;
    projects_section_subtitle_en?: string | null;
    bottom_cta_eyebrow_cn?: string | null;
    bottom_cta_eyebrow_en?: string | null;
    bottom_cta_button_text_cn?: string | null;
    bottom_cta_button_text_en?: string | null;
  }
}

export {};
