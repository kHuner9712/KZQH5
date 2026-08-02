export interface HomeHeroSlide {
  id: string;
  enabled: boolean;
  desktop_image_url: string;
  mobile_image_url: string | null;
  alt_cn: string | null;
  alt_en: string | null;
  eyebrow_cn: string | null;
  eyebrow_en: string | null;
  title_cn: string | null;
  title_en: string | null;
  highlight_cn: string | null;
  highlight_en: string | null;
  description_cn: string | null;
  description_en: string | null;
  primary_cta_text_cn: string | null;
  primary_cta_text_en: string | null;
  primary_cta_href: string | null;
  secondary_cta_text_cn: string | null;
  secondary_cta_text_en: string | null;
  secondary_cta_href: string | null;
  focal_x: number;
  focal_y: number;
  overlay_opacity: number;
}
