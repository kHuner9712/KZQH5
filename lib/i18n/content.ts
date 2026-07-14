import type {
  Category,
  Certificate,
  CompanyProfile,
  HomeFeatureItem,
  HomepageContent,
  NavItem,
  PageContent,
  PageSection,
  Product,
  ProductFaqItem,
  ProductImage,
  ProductAsset,
  Project,
  ProjectImage,
  SiteSettings,
  Subcategory,
} from "@/types/database";
import type { Locale } from "./config";

type LocalizedSource = Record<string, unknown>;

export function localizedValue<T>(
  source: LocalizedSource | null | undefined,
  field: string,
  locale: Locale,
  fallback?: T
): T | null {
  if (!source) return fallback ?? null;
  const preferredKey = `${field}_${locale === "en" ? "en" : "cn"}`;
  const fallbackKey = `${field}_${locale === "en" ? "cn" : "en"}`;
  const preferred = source[preferredKey] as T | null | undefined;
  if (preferred !== null && preferred !== undefined && preferred !== "") return preferred;
  const secondary = source[fallbackKey] as T | null | undefined;
  if (secondary !== null && secondary !== undefined && secondary !== "") return secondary;
  return fallback ?? null;
}

export function localizeCategory(category: Category, locale: Locale) {
  return {
    name: localizedValue<string>(category as unknown as LocalizedSource, "name", locale, category.name_cn)!,
    secondaryName: locale === "zh" ? category.name_en : null,
    description: localizedValue<string>(category as unknown as LocalizedSource, "description", locale),
  };
}

export function localizeSubcategory(subcategory: Subcategory, locale: Locale) {
  return {
    name: localizedValue<string>(subcategory as unknown as LocalizedSource, "name", locale, subcategory.name_cn)!,
    description: localizedValue<string>(subcategory as unknown as LocalizedSource, "description", locale),
  };
}

export function localizeProduct(product: Product, locale: Locale) {
  const source = product as unknown as LocalizedSource;
  return {
    name: localizedValue<string>(source, "name", locale, product.name_cn)!,
    secondaryName: locale === "zh" ? product.name_en : null,
    summary: localizedValue<string>(source, "summary", locale),
    description: localizedValue<string>(source, "description", locale),
    material: localizedValue<string>(source, "material", locale),
    packaging: localizedValue<string>(source, "packaging", locale),
    logistics: localizedValue<string>(source, "logistics", locale),
    application: localizedValue<string>(source, "application", locale),
    price: localizedValue<string>(source, "price_display", locale),
    seoTitle: localizedValue<string>(source, "seo_title", locale),
    seoDescription: localizedValue<string>(source, "seo_description", locale),
    geoSummary: localizedValue<string>(source, "geo_summary", locale),
    keywords: localizedValue<string[]>(source, "keywords", locale),
    faq: localizedValue<ProductFaqItem[]>(source, "faq", locale),
  };
}

export function localizeProductImage(image: ProductImage, locale: Locale, fallback: string) {
  return localizedValue<string>(image as unknown as LocalizedSource, "alt", locale, fallback)!;
}

export function localizeProductAsset(asset: ProductAsset, locale: Locale) {
  const source = asset as unknown as LocalizedSource;
  return {
    title: localizedValue<string>(source, "title", locale, asset.title_cn)!,
    description: localizedValue<string>(source, "description", locale),
  };
}

export function localizeProject(project: Project, locale: Locale) {
  const source = project as unknown as LocalizedSource;
  return {
    title: localizedValue<string>(source, "title", locale, project.title_cn)!,
    summary: localizedValue<string>(source, "summary", locale),
    description: localizedValue<string>(source, "description", locale),
    country: localizedValue<string>(source, "country", locale),
    projectType: localizedValue<string>(source, "project_type", locale),
    seoTitle: localizedValue<string>(source, "seo_title", locale),
    seoDescription: localizedValue<string>(source, "seo_description", locale),
  };
}

export function localizeProjectImage(image: ProjectImage, locale: Locale, fallback: string) {
  return localizedValue<string>(image as unknown as LocalizedSource, "alt", locale, fallback)!;
}

export function navigationWithProjects(items: NavItem[] | null | undefined): NavItem[] {
  const navigation = [...(items || [])];
  if (!navigation.some((item) => item.href === "/projects")) {
    const contactIndex = navigation.findIndex((item) => item.href === "/contact");
    navigation.splice(contactIndex >= 0 ? contactIndex : navigation.length, 0, {
      href: "/projects",
      label_cn: "应用案例",
      label_en: "Projects",
      sort_order: contactIndex >= 0 ? (navigation[contactIndex].sort_order ?? contactIndex + 1) - 0.5 : navigation.length + 1,
    });
  }
  return navigation.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

export function localizeCertificate(certificate: Certificate, locale: Locale) {
  const source = certificate as unknown as LocalizedSource;
  return {
    name: localizedValue<string>(source, "name", locale, certificate.name_cn)!,
    secondaryName: locale === "zh" ? certificate.name_en : null,
    description: localizedValue<string>(source, "description", locale),
    applicableScope: localizedValue<string>(source, "applicable_scope", locale),
  };
}

export function localizeCompany(company: CompanyProfile | null | undefined, locale: Locale) {
  const source = company as unknown as LocalizedSource | null | undefined;
  const advantages = localizedValue<CompanyProfile["advantages_cn"]>(source, "advantages", locale) || [];
  return {
    title: localizedValue<string>(source, "title", locale),
    description: localizedValue<string>(source, "description", locale),
    address: localizedValue<string>(source, "address", locale),
    advantages: advantages.map((item) => ({
      icon: item.icon,
      title: localizedValue<string>(item as unknown as LocalizedSource, "title", locale, item.title_cn)!,
      description: localizedValue<string>(item as unknown as LocalizedSource, "desc", locale, item.desc_cn)!,
    })),
  };
}

export function localizeHomepage(home: HomepageContent | null | undefined, locale: Locale) {
  const source = home as unknown as LocalizedSource | null | undefined;
  return {
    heroEyebrow: localizedValue<string>(source, "hero_eyebrow", locale),
    heroTitle: localizedValue<string>(source, "hero_title", locale),
    heroHighlight: localizedValue<string>(source, "hero_highlight", locale),
    heroDescription: localizedValue<string>(source, "hero_description", locale),
    primaryCta: localizedValue<string>(source, "primary_cta_text", locale),
    secondaryCta: localizedValue<string>(source, "secondary_cta_text", locale),
    featureTitle: localizedValue<string>(source, "feature_section_title", locale),
    featureSubtitle: localizedValue<string>(source, "feature_section_subtitle", locale),
    features: localizedValue<HomeFeatureItem[]>(source, "features", locale) || [],
    categoryTitle: localizedValue<string>(source, "category_section_title", locale),
    categorySubtitle: localizedValue<string>(source, "category_section_subtitle", locale),
    featuredTitle: localizedValue<string>(source, "featured_products_title", locale),
    featuredSubtitle: localizedValue<string>(source, "featured_products_subtitle", locale),
    bottomCtaTitle: localizedValue<string>(source, "bottom_cta_title", locale),
    bottomCtaDescription: localizedValue<string>(source, "bottom_cta_description", locale),
  };
}

export function localizePage(page: PageContent | null | undefined, locale: Locale) {
  const source = page as unknown as LocalizedSource | null | undefined;
  return {
    title: localizedValue<string>(source, "title", locale),
    subtitle: localizedValue<string>(source, "subtitle", locale),
    description: localizedValue<string>(source, "description", locale),
    sections: localizedValue<PageSection[]>(source, "sections", locale) || [],
    seoTitle: localizedValue<string>(source, "seo_title", locale),
    seoDescription: localizedValue<string>(source, "seo_description", locale),
  };
}

export function localizeSiteSettings(settings: SiteSettings | null | undefined, locale: Locale) {
  const source = settings as unknown as LocalizedSource | null | undefined;
  return {
    siteName: localizedValue<string>(source, "site_name", locale, settings?.site_name || "KZQ")!,
    metaTitle: localizedValue<string>(source, "global_meta_title", locale),
    metaDescription: localizedValue<string>(source, "global_meta_description", locale),
    footerText: localizedValue<string>(source, "footer_text", locale),
  };
}

export function localizeNavItem(item: NavItem, locale: Locale): string {
  return localizedValue<string>(item as unknown as LocalizedSource, "label", locale, item.label_cn)!;
}
