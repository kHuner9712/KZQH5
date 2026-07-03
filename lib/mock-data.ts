// ============================================================
// KZQ 前端 Demo / Mock Preview 数据
// 当 NEXT_PUBLIC_DEMO_MODE=true 时，前台页面不请求 Supabase，直接使用此数据。
// 产品图片不依赖外部图源，全部使用 CSS 板材纹理占位（由 ProductImage 组件渲染），零破图。
// ============================================================

import type {
  Category,
  Subcategory,
  Product,
  ProductImage,
  Certificate,
  CompanyProfile,
  SiteSettings,
  HomepageContent,
  PageContent,
  ProductFaqItem,
  HomeFeatureItem,
  NavItem,
} from "@/types/database";

// ---------- 工具：生成稳定的 mock id ----------
const id = (s: string) => `mock-${s}`;
const now = "2026-06-01T00:00:00.000Z";

// ---------- 公司信息 ----------
export const mockCompany: CompanyProfile = {
  id: id("company"),
  title_cn: "KZQ · 工程级板材品牌",
  title_en: "KZQ · Engineering-Grade Boards",
  description_cn:
    "KZQ 专注工程级板材与装饰饰面，产品涵盖防火板、饰面板、UV 涂装板等多个品类，服务国内工程精装与海外采购，支持规格定制与 FOB / CIF 出口。",
  description_en:
    "KZQ specializes in engineering-grade boards and decorative panels, serving domestic projects and overseas buyers with fire-rated and eco-friendly solutions.",
  advantages_cn: [
    {
      icon: "flame",
      title_cn: "B 级防火",
      title_en: "B-Class Fire Rating",
      desc_cn: "核心产品通过第三方燃烧性能检测，达到 B 级防火标准。",
      desc_en: "Core products tested to B-class fire performance standards.",
    },
    {
      icon: "leaf",
      title_cn: "E0 环保",
      title_en: "E0 Eco Grade",
      desc_cn: "甲醛释放量达到 E0 级，适合室内精装与海外工程应用。",
      desc_en: "E0 formaldehyde emission suitable for interiors and export projects.",
    },
    {
      icon: "truck",
      title_cn: "稳定交付",
      title_en: "Stable Delivery",
      desc_cn: "规模化产能保障工程批量供货，国内整车配送与海外集装箱出口并行。",
      desc_en: "Scaled capacity for batch supply, domestic and export logistics.",
    },
    {
      icon: "globe",
      title_cn: "海外出口",
      title_en: "Overseas Export",
      desc_cn: "支持多语言询盘响应，FOB / CIF 条款灵活，海外客户可在线提交询盘。",
      desc_en: "Multilingual inquiry, FOB/CIF terms, online inquiry for global buyers.",
    },
  ],
  advantages_en: [
    {
      icon: "flame",
      title_cn: "B 级防火",
      title_en: "B-Class Fire Rating",
      desc_cn: "核心产品通过第三方燃烧性能检测，达到 B 级防火标准。",
      desc_en: "Core products tested to B-class fire performance standards.",
    },
    {
      icon: "leaf",
      title_cn: "E0 环保",
      title_en: "E0 Eco Grade",
      desc_cn: "甲醛释放量达到 E0 级，适合室内精装与海外工程应用。",
      desc_en: "E0 formaldehyde emission suitable for interiors and export projects.",
    },
    {
      icon: "truck",
      title_cn: "稳定交付",
      title_en: "Stable Delivery",
      desc_cn: "规模化产能保障工程批量供货，国内整车配送与海外集装箱出口并行。",
      desc_en: "Scaled capacity for batch supply, domestic and export logistics.",
    },
    {
      icon: "globe",
      title_cn: "海外出口",
      title_en: "Overseas Export",
      desc_cn: "支持多语言询盘响应，FOB / CIF 条款灵活，海外客户可在线提交询盘。",
      desc_en: "Multilingual inquiry, FOB/CIF terms, online inquiry for global buyers.",
    },
  ],
  phone: "+86 400-888-0000",
  email: "sales@kzq-demo.com",
  whatsapp: "+86 138 0000 0000",
  address_cn: "中国 · 广东省 · 工程级板材产业基地",
  address_en: "Engineering Board Industrial Base, Guangdong, China",
  wechat_qr_url: null,
  logo_url: null,
  updated_at: now,
};

// ---------- 一级类目 ----------
export const mockCategories: Category[] = [
  {
    id: id("cat-fireproof"),
    name_cn: "防火板",
    name_en: "Fireproof Boards",
    slug: "fireproof-boards",
    description_cn: "B 级防火工程板材，适用于公共场所与商业空间。",
    description_en: "B-class fire-rated boards for public and commercial spaces.",
    sort_order: 1,
    is_active: true,
    created_at: now,
    updated_at: now,
  },
  {
    id: id("cat-decorative"),
    name_cn: "饰面板",
    name_en: "Decorative Panels",
    slug: "decorative-panels",
    description_cn: "装饰饰面板，表面纹理丰富，适合室内精装。",
    description_en: "Decorative panels with rich surface textures for interiors.",
    sort_order: 2,
    is_active: true,
    created_at: now,
    updated_at: now,
  },
  {
    id: id("cat-engineering"),
    name_cn: "工程板材",
    name_en: "Engineering Boards",
    slug: "engineering-boards",
    description_cn: "工程批量应用基材，稳定供应，规格可定制。",
    description_en: "Engineering substrates with stable supply and custom sizes.",
    sort_order: 3,
    is_active: true,
    created_at: now,
    updated_at: now,
  },
];

// ---------- 二级类目 ----------
export const mockSubcategories: Subcategory[] = [
  // 防火板下
  {
    id: id("sub-mg"),
    category_id: id("cat-fireproof"),
    name_cn: "玻镁防火板",
    name_en: "Magnesium Fire Board",
    slug: "magnesium-fire-board",
    description_cn: "玻镁基材防火板，B 级防火。",
    description_en: "Magnesium-based fire board.",
    sort_order: 1,
    is_active: true,
    created_at: now,
    updated_at: now,
  },
  {
    id: id("sub-fr-core"),
    category_id: id("cat-fireproof"),
    name_cn: "阻燃基材板",
    name_en: "Fire-Retardant Core",
    slug: "fire-retardant-core",
    description_cn: "阻燃处理基材，工程应用防火。",
    description_en: "Fire-retardant treated core.",
    sort_order: 2,
    is_active: true,
    created_at: now,
    updated_at: now,
  },
  // 饰面板下
  {
    id: id("sub-melamine"),
    category_id: id("cat-decorative"),
    name_cn: "三聚氰胺饰面板",
    name_en: "Melamine Faced Panel",
    slug: "melamine-faced-panel",
    description_cn: "三聚氰胺饰面，纹理逼真，耐磨易清洁。",
    description_en: "Melamine faced panel.",
    sort_order: 1,
    is_active: true,
    created_at: now,
    updated_at: now,
  },
  {
    id: id("sub-uv"),
    category_id: id("cat-decorative"),
    name_cn: "UV 涂装板",
    name_en: "UV Coated Panel",
    slug: "uv-coated-panel",
    description_cn: "UV 固化涂装，光泽持久，环保性能好。",
    description_en: "UV cured coated panel.",
    sort_order: 2,
    is_active: true,
    created_at: now,
    updated_at: now,
  },
  // 工程板材下
  {
    id: id("sub-mdf"),
    category_id: id("cat-engineering"),
    name_cn: "高密度基材",
    name_en: "High-Density Substrate",
    slug: "high-density-substrate",
    description_cn: "高密度工程基材，规格齐全。",
    description_en: "High-density engineering substrate.",
    sort_order: 1,
    is_active: true,
    created_at: now,
    updated_at: now,
  },
  {
    id: id("sub-plywood"),
    category_id: id("cat-engineering"),
    name_cn: "工程多层板",
    name_en: "Engineering Plywood",
    slug: "engineering-plywood",
    description_cn: "工程多层结构，稳定不易变形。",
    description_en: "Engineering plywood.",
    sort_order: 2,
    is_active: true,
    created_at: now,
    updated_at: now,
  },
];

// ---------- 产品图片（统一 helper） ----------
// Demo 模式下不依赖外部图片，全部使用 CSS 板材纹理占位（由 ProductImage 组件渲染）
// 这样可保证零破图、加载快、视觉统一，符合工程级板材品牌调性
function img(alt: string, sort = 0): ProductImage {
  return {
    id: id(`img-${sort}-${alt}`),
    product_id: "",
    image_url: null,
    alt_cn: alt,
    alt_en: alt,
    sort_order: sort,
    created_at: now,
  };
}

function cover(): null {
  return null;
}

// ---------- 产品列表（8 个） ----------
// rawProducts 不含 GEO 字段，下方通过 map 注入 GEO 默认值与示例 FAQ
type RawProduct = Omit<
  Product,
  | "seo_title_cn" | "seo_title_en" | "seo_description_cn" | "seo_description_en"
  | "geo_summary_cn" | "geo_summary_en"
  | "keywords_cn" | "keywords_en"
  | "faq_cn" | "faq_en"
  | "search_aliases" | "schema_extra"
>;
const rawProducts: RawProduct[] = [
  {
    id: id("p1"),
    category_id: id("cat-fireproof"),
    subcategory_id: id("sub-mg"),
    name_cn: "KZQ 玻镁防火板 1220×2440×9mm",
    name_en: "KZQ Magnesium Fire Board 1220×2440×9mm",
    slug: "kzq-magnesium-fire-board-1220x2440x9",
    summary_cn: "B 级防火玻镁板，适用于公共空间与商业工程防火饰面。",
    summary_en: "B-class magnesium fire board for public and commercial fire-rated finishes.",
    description_cn:
      "KZQ 玻镁防火板采用无机玻镁基材，燃烧性能达 B 级，防潮稳定，适用于酒店、商场、写字楼等公共场所的防火饰面工程。\n\n产品经第三方检测，配套工程批量供货，可定制规格，支持国内配送与海外集装箱出口。",
    description_en:
      "KZQ magnesium fire board uses inorganic magnesium substrate, B-class fire rating, suitable for hotels, malls, offices and other public spaces.",
    material_cn: "玻镁无机基材",
    material_en: "Magnesium inorganic substrate",
    size: "1220×2440×9mm（可定制）",
    fire_rating: "B级",
    eco_grade: "E0级",
    price_display_cn: "请联系销售获取报价",
    price_display_en: "Contact for quotation",
    moq: "100 张 / 1×20GP",
    packaging_cn: "木托盘包装，防潮覆膜，每托约 80 张",
    packaging_en: "Wooden pallet, moisture film, ~80 sheets/pallet",
    logistics_cn: "国内整车配送 / 海外集装箱 FOB / CIF",
    logistics_en: "Domestic truck / Overseas container FOB / CIF",
    application_cn: "酒店 · 商场 · 写字楼 · 公共空间防火饰面",
    application_en: "Hotels, malls, offices, public fire-rated finishes",
    video_url: null,
    cover_image_url: cover(),
    is_featured: true,
    is_published: true,
    sort_order: 1,
    created_at: now,
    updated_at: now,
    product_images: [
      img("玻镁防火板正面", 0),
      img("玻镁防火板细节", 1),
      img("玻镁防火板应用", 2),
    ],
  },
  {
    id: id("p2"),
    category_id: id("cat-fireproof"),
    subcategory_id: id("sub-fr-core"),
    name_cn: "KZQ 阻燃基材板 1220×2440×12mm",
    name_en: "KZQ Fire-Retardant Core 1220×2440×12mm",
    slug: "kzq-fire-retardant-core-1220x2440x12",
    summary_cn: "阻燃处理基材板，B 级防火，工程批量应用稳定。",
    summary_en: "Fire-retardant treated core, B-class, stable for engineering batch use.",
    description_cn:
      "KZQ 阻燃基材板经阻燃处理，达到 B 级防火，基材稳定不易变形，适合工程批量供货与海外出口。",
    description_en:
      "KZQ fire-retardant core is treated to B-class fire rating, dimensionally stable, suitable for engineering batch supply and export.",
    material_cn: "阻燃处理工程基材",
    material_en: "Fire-retardant treated engineering substrate",
    size: "1220×2440×12mm（可定制）",
    fire_rating: "B级",
    eco_grade: "E0级",
    price_display_cn: "请联系销售获取报价",
    price_display_en: "Contact for quotation",
    moq: "200 张 / 1×20GP",
    packaging_cn: "木托盘包装，防潮覆膜",
    packaging_en: "Wooden pallet, moisture film",
    logistics_cn: "国内整车配送 / 海外集装箱 FOB / CIF",
    logistics_en: "Domestic truck / Overseas container FOB / CIF",
    application_cn: "工程防火饰面 · 商业空间 · 海外工程",
    application_en: "Fire-rated finishes, commercial spaces, export projects",
    video_url: null,
    cover_image_url: cover(),
    is_featured: true,
    is_published: true,
    sort_order: 2,
    created_at: now,
    updated_at: now,
    product_images: [
      img("阻燃基材板正面", 0),
      img("阻燃基材板细节", 1),
    ],
  },
  {
    id: id("p3"),
    category_id: id("cat-decorative"),
    subcategory_id: id("sub-melamine"),
    name_cn: "KZQ 三聚氰胺饰面板 木纹系列",
    name_en: "KZQ Melamine Faced Panel Wood Grain",
    slug: "kzq-melamine-faced-panel-wood-grain",
    summary_cn: "木纹三聚氰胺饰面，纹理逼真，耐磨易清洁，E0 环保。",
    summary_en: "Wood grain melamine panel, realistic, wear-resistant, E0 eco.",
    description_cn:
      "KZQ 三聚氰胺饰面板采用进口饰面纸，木纹逼真，表面耐磨抗刮，E0 级环保，适合室内精装与家具应用。\n\n支持多种纹理与色彩定制，工程批量供货。",
    description_en:
      "KZQ melamine panel uses imported paper, realistic wood grain, wear-resistant, E0 eco grade, suitable for interiors and furniture.",
    material_cn: "三聚氰胺饰面 + 工程基材",
    material_en: "Melamine face + engineering substrate",
    size: "1220×2440×18mm（可定制）",
    fire_rating: "B级",
    eco_grade: "E0级",
    price_display_cn: "请联系销售获取报价",
    price_display_en: "Contact for quotation",
    moq: "300 张 / 1×40GP",
    packaging_cn: "木托盘包装，每托约 60 张",
    packaging_en: "Wooden pallet, ~60 sheets/pallet",
    logistics_cn: "国内整车配送 / 海外集装箱 FOB / CIF",
    logistics_en: "Domestic truck / Overseas container FOB / CIF",
    application_cn: "室内精装 · 家具 · 商业空间饰面",
    application_en: "Interiors, furniture, commercial finishes",
    video_url: null,
    cover_image_url: cover(),
    is_featured: true,
    is_published: true,
    sort_order: 3,
    created_at: now,
    updated_at: now,
    product_images: [
      img("三聚氰胺饰面板正面", 0),
      img("三聚氰胺饰面板细节", 1),
    ],
  },
  {
    id: id("p4"),
    category_id: id("cat-decorative"),
    subcategory_id: id("sub-uv"),
    name_cn: "KZQ UV 涂装板 高光系列",
    name_en: "KZQ UV Coated Panel High Gloss",
    slug: "kzq-uv-coated-panel-high-gloss",
    summary_cn: "UV 固化涂装，高光镜面效果，环保耐久。",
    summary_en: "UV cured coating, high-gloss mirror finish, eco and durable.",
    description_cn:
      "KZQ UV 涂装板采用 UV 固化工艺，高光镜面效果，硬度高、耐刮擦、E0 环保，适合高端室内精装与展示空间。",
    description_en:
      "KZQ UV coated panel uses UV curing process, high-gloss mirror finish, hard, scratch-resistant, E0 eco.",
    material_cn: "UV 固化涂装 + 工程基材",
    material_en: "UV cured coating + engineering substrate",
    size: "1220×2440×18mm（可定制）",
    fire_rating: "B级",
    eco_grade: "E0级",
    price_display_cn: "请联系销售获取报价",
    price_display_en: "Contact for quotation",
    moq: "200 张 / 1×20GP",
    packaging_cn: "木托盘包装，防刮覆膜",
    packaging_en: "Wooden pallet, scratch-proof film",
    logistics_cn: "国内整车配送 / 海外集装箱 FOB / CIF",
    logistics_en: "Domestic truck / Overseas container FOB / CIF",
    application_cn: "高端室内精装 · 展示空间 · 家具饰面",
    application_en: "Premium interiors, display spaces, furniture finishes",
    video_url: null,
    cover_image_url: cover(),
    is_featured: true,
    is_published: true,
    sort_order: 4,
    created_at: now,
    updated_at: now,
    product_images: [
      img("UV 涂装板正面", 0),
      img("UV 涂装板细节", 1),
    ],
  },
  {
    id: id("p5"),
    category_id: id("cat-engineering"),
    subcategory_id: id("sub-mdf"),
    name_cn: "KZQ 高密度基材板 1220×2440×9mm",
    name_en: "KZQ High-Density Substrate 1220×2440×9mm",
    slug: "kzq-high-density-substrate-1220x2440x9",
    summary_cn: "高密度工程基材，结构稳定，规格齐全。",
    summary_en: "High-density engineering substrate, stable, full sizes.",
    description_cn:
      "KZQ 高密度基材板密度均匀，结构稳定，适合作为饰面、涂装、贴面的工程基材，规格齐全可定制。",
    description_en:
      "KZQ high-density substrate has uniform density, stable structure, suitable as substrate for facing, coating and laminating.",
    material_cn: "高密度工程基材",
    material_en: "High-density engineering substrate",
    size: "1220×2440×9mm（可定制）",
    fire_rating: "B级",
    eco_grade: "E0级",
    price_display_cn: "请联系销售获取报价",
    price_display_en: "Contact for quotation",
    moq: "500 张 / 1×40GP",
    packaging_cn: "木托盘包装",
    packaging_en: "Wooden pallet",
    logistics_cn: "国内整车配送 / 海外集装箱 FOB / CIF",
    logistics_en: "Domestic truck / Overseas container FOB / CIF",
    application_cn: "工程基材 · 饰面基材 · 涂装基材",
    application_en: "Engineering substrate, facing substrate, coating substrate",
    video_url: null,
    cover_image_url: cover(),
    is_featured: false,
    is_published: true,
    sort_order: 5,
    created_at: now,
    updated_at: now,
    product_images: [
      img("高密度基材板正面", 0),
    ],
  },
  {
    id: id("p6"),
    category_id: id("cat-engineering"),
    subcategory_id: id("sub-plywood"),
    name_cn: "KZQ 工程多层板 1220×2440×15mm",
    name_en: "KZQ Engineering Plywood 1220×2440×15mm",
    slug: "kzq-engineering-plywood-1220x2440x15",
    summary_cn: "工程多层结构，稳定不易变形，B 级防火。",
    summary_en: "Engineering plywood, stable, B-class fire rated.",
    description_cn:
      "KZQ 工程多层板采用多层结构，纵横交错压制，稳定不易变形，B 级防火，适合工程结构与饰面基材应用。",
    description_en:
      "KZQ engineering plywood uses multi-layer cross-pressed structure, stable, B-class fire rated, suitable for engineering structure and substrate.",
    material_cn: "工程多层结构",
    material_en: "Engineering multi-layer structure",
    size: "1220×2440×15mm（可定制）",
    fire_rating: "B级",
    eco_grade: "E0级",
    price_display_cn: "请联系销售获取报价",
    price_display_en: "Contact for quotation",
    moq: "300 张 / 1×20GP",
    packaging_cn: "木托盘包装",
    packaging_en: "Wooden pallet",
    logistics_cn: "国内整车配送 / 海外集装箱 FOB / CIF",
    logistics_en: "Domestic truck / Overseas container FOB / CIF",
    application_cn: "工程结构 · 饰面基材 · 家具应用",
    application_en: "Engineering structure, substrate, furniture",
    video_url: null,
    cover_image_url: cover(),
    is_featured: false,
    is_published: true,
    sort_order: 6,
    created_at: now,
    updated_at: now,
    product_images: [
      img("工程多层板正面", 0),
    ],
  },
  {
    id: id("p7"),
    category_id: id("cat-decorative"),
    subcategory_id: id("sub-melamine"),
    name_cn: "KZQ 三聚氰胺饰面板 素色系列",
    name_en: "KZQ Melamine Faced Panel Solid Color",
    slug: "kzq-melamine-faced-panel-solid-color",
    summary_cn: "素色饰面，简洁现代，E0 环保。",
    summary_en: "Solid color melamine, modern, E0 eco.",
    description_cn:
      "KZQ 素色三聚氰胺饰面板，色彩纯净，表面耐磨易清洁，E0 环保，适合现代风格室内精装。",
    description_en:
      "KZQ solid color melamine panel, pure color, wear-resistant, E0 eco, suitable for modern interiors.",
    material_cn: "三聚氰胺饰面 + 工程基材",
    material_en: "Melamine face + engineering substrate",
    size: "1220×2440×18mm（可定制）",
    fire_rating: "B级",
    eco_grade: "E0级",
    price_display_cn: "请联系销售获取报价",
    price_display_en: "Contact for quotation",
    moq: "300 张 / 1×40GP",
    packaging_cn: "木托盘包装",
    packaging_en: "Wooden pallet",
    logistics_cn: "国内整车配送 / 海外集装箱 FOB / CIF",
    logistics_en: "Domestic truck / Overseas container FOB / CIF",
    application_cn: "现代室内精装 · 家具 · 商业空间",
    application_en: "Modern interiors, furniture, commercial spaces",
    video_url: null,
    cover_image_url: cover(),
    is_featured: false,
    is_published: true,
    sort_order: 7,
    created_at: now,
    updated_at: now,
    product_images: [
      img("素色饰面板正面", 0),
    ],
  },
  {
    id: id("p8"),
    category_id: id("cat-fireproof"),
    subcategory_id: id("sub-mg"),
    name_cn: "KZQ 玻镁防火板 1220×2440×12mm",
    name_en: "KZQ Magnesium Fire Board 1220×2440×12mm",
    slug: "kzq-magnesium-fire-board-1220x2440x12",
    summary_cn: "12mm 加厚玻镁防火板，B 级防火，工程首选。",
    summary_en: "12mm thick magnesium fire board, B-class, engineering choice.",
    description_cn:
      "KZQ 12mm 加厚玻镁防火板，结构更稳定，B 级防火，适合对强度与防火要求更高的工程应用。",
    description_en:
      "KZQ 12mm thick magnesium fire board, more stable, B-class fire rated, for higher strength and fire requirements.",
    material_cn: "玻镁无机基材",
    material_en: "Magnesium inorganic substrate",
    size: "1220×2440×12mm（可定制）",
    fire_rating: "B级",
    eco_grade: "E0级",
    price_display_cn: "请联系销售获取报价",
    price_display_en: "Contact for quotation",
    moq: "100 张 / 1×20GP",
    packaging_cn: "木托盘包装，防潮覆膜",
    packaging_en: "Wooden pallet, moisture film",
    logistics_cn: "国内整车配送 / 海外集装箱 FOB / CIF",
    logistics_en: "Domestic truck / Overseas container FOB / CIF",
    application_cn: "高强度防火工程 · 商业空间 · 海外工程",
    application_en: "High-strength fire projects, commercial, export",
    video_url: null,
    cover_image_url: cover(),
    is_featured: false,
    is_published: true,
    sort_order: 8,
    created_at: now,
    updated_at: now,
    product_images: [
      img("加厚玻镁防火板正面", 0),
    ],
  },
];

// ---------- 产品 GEO / SEO 字段示例 ----------
// 为部分产品注入 GEO 内容（FAQ / keywords / geo_summary），其余保持 null。
// 口径：B级防火 / E0环保 / 无实木/A1/未确认认证。
const productGeoMap: Record<
  string,
  {
    seo_title_cn?: string;
    seo_description_cn?: string;
    geo_summary_cn?: string;
    keywords_cn?: string[];
    keywords_en?: string[];
    faq_cn?: ProductFaqItem[];
  }
> = {
  "kzq-magnesium-fire-board-1220x2440x9": {
    seo_title_cn: "KZQ 玻镁防火板 1220×2440×9mm | B级防火 E0环保",
    seo_description_cn:
      "KZQ 玻镁防火板 9mm，B 级防火，遇火不燃，无有毒烟雾，适用于酒店、商场等公共场所防火饰面。",
    geo_summary_cn:
      "KZQ 玻镁防火板面向公共空间防火饰面工程，B 级防火，可定制规格，支持国内配送与海外出口。",
    keywords_cn: ["玻镁防火板", "B级防火板", "防火基材", "工程防火板", "海外出口防火板"],
    keywords_en: ["magnesium fire board", "B-rated fire board", "fire substrate", "export fire board"],
    faq_cn: [
      {
        question: "KZQ 玻镁防火板适合哪些应用？",
        answer: "适用于酒店、商场、写字楼等公共场所的防火饰面工程。",
      },
      {
        question: "防火与环保等级是什么？",
        answer: "B 级防火，E0 级环保，具体以产品详情与资质证书为准。",
      },
      {
        question: "是否支持海外出口？",
        answer: "支持，国内整车配送 / 海外集装箱 FOB / CIF。",
      },
    ],
  },
  "kzq-fire-retardant-core-1220x2440x12": {
    seo_title_cn: "KZQ 阻燃基材板 1220×2440×12mm | B级防火",
    seo_description_cn: "KZQ 阻燃基材板，B 级防火，基材稳定，适合工程批量供货与海外出口。",
    geo_summary_cn: "KZQ 阻燃基材板面向工程防火应用，B 级防火，规格可定制，支持 FOB/CIF 出口。",
    keywords_cn: ["阻燃基材板", "B级防火板", "工程基材", "海外出口板材"],
    keywords_en: ["fire-retardant core", "B-rated fire board", "engineering substrate", "export board"],
    faq_cn: [
      {
        question: "阻燃基材板的防火等级？",
        answer: "B 级防火，基材稳定不易变形。",
      },
    ],
  },
  "kzq-melamine-faced-panel-wood-grain": {
    seo_title_cn: "KZQ 三聚氰胺饰面板 木纹系列 | B级 E0",
    seo_description_cn: "KZQ 木纹三聚氰胺饰面板，耐磨抗刮，B 级防火，E0 环保，适用于全屋定制与办公家具。",
    geo_summary_cn: "KZQ 三聚氰胺饰面板木纹系列面向全屋定制与办公家具，B 级防火、E0 环保，花色可定制。",
    keywords_cn: ["三聚氰胺饰面板", "木纹饰面板", "B级防火饰面板", "E0环保饰面板", "定制饰面板"],
    keywords_en: ["melamine faced panel", "wood grain panel", "B-rated fire panel", "E0 eco panel"],
    faq_cn: [
      {
        question: "KZQ 三聚氰胺饰面板可以定制花色吗？",
        answer: "可以，支持多种纹理与色彩定制，工程批量供货。",
      },
      {
        question: "防火与环保等级？",
        answer: "B 级防火，E0 级环保。",
      },
    ],
  },
};

// 将 rawProducts 合并 GEO 字段后导出为完整 Product[]
export const mockProducts: Product[] = rawProducts.map((p) => {
  const geo = productGeoMap[p.slug];
  return {
    ...p,
    seo_title_cn: geo?.seo_title_cn ?? null,
    seo_title_en: null,
    seo_description_cn: geo?.seo_description_cn ?? null,
    seo_description_en: null,
    geo_summary_cn: geo?.geo_summary_cn ?? null,
    geo_summary_en: null,
    keywords_cn: geo?.keywords_cn ?? null,
    keywords_en: geo?.keywords_en ?? null,
    faq_cn: geo?.faq_cn ?? null,
    faq_en: null,
    search_aliases: null,
    schema_extra: null,
  };
});

// 暴露为图集（含 product_id 关联）
export const mockProductImages: ProductImage[] = mockProducts.flatMap((p) =>
  (p.product_images || []).map((im) => ({ ...im, product_id: p.id }))
);

// ---------- 证书列表 ----------
export const mockCertificates: Certificate[] = [
  {
    id: id("cert-fire"),
    name_cn: "B 级防火检测报告",
    name_en: "B-Class Fire Test Report",
    description_cn: "第三方燃烧性能检测，达到 B 级防火标准（展示版）。",
    description_en: "Third-party fire performance test, B-class (display version).",
    image_url: null,
    applicable_scope_cn: "玻镁防火板 / 阻燃基材板",
    applicable_scope_en: "Magnesium fire board / fire-retardant core",
    is_published: true,
    sort_order: 1,
    created_at: now,
    updated_at: now,
  },
  {
    id: id("cert-eco"),
    name_cn: "E0 环保检测报告",
    name_en: "E0 Eco Test Report",
    description_cn: "甲醛释放量检测，达到 E0 级（展示版）。",
    description_en: "Formaldehyde emission test, E0 grade (display version).",
    image_url: null,
    applicable_scope_cn: "全部产品",
    applicable_scope_en: "All products",
    is_published: true,
    sort_order: 2,
    created_at: now,
    updated_at: now,
  },
  {
    id: id("cert-qc"),
    name_cn: "产品出厂资料汇总",
    name_en: "Product Documentation Summary",
    description_cn: "已确认可公开展示的环保、防火及相关产品资料（展示版），完整证书请联系销售。",
    description_en: "Confirmed public eco/fire/product documents (display version). Full docs on request.",
    image_url: null,
    applicable_scope_cn: "环保 / 防火 / 产品资料",
    applicable_scope_en: "Eco / Fire / Product documents",
    is_published: true,
    sort_order: 3,
    created_at: now,
    updated_at: now,
  },
];

// ============================================================
// 数据访问辅助函数（模拟 Supabase 查询）
// ============================================================

export function getMockFeaturedProducts(limit = 6): Product[] {
  return mockProducts
    .filter((p) => p.is_featured)
    .sort((a, b) => a.sort_order - b.sort_order)
    .slice(0, limit);
}

export function getMockProductBySlug(slug: string): Product | null {
  return mockProducts.find((p) => p.slug === slug) || null;
}

export function getMockProductImages(productId: string): ProductImage[] {
  return mockProductImages
    .filter((im) => im.product_id === productId)
    .sort((a, b) => a.sort_order - b.sort_order);
}

export function getMockProductsByCategory(categoryId?: string): Product[] {
  if (!categoryId) return [...mockProducts].sort((a, b) => a.sort_order - b.sort_order);
  return mockProducts
    .filter((p) => p.category_id === categoryId)
    .sort((a, b) => a.sort_order - b.sort_order);
}

export function getMockCategoryBySlug(slug?: string): Category | undefined {
  if (!slug) return undefined;
  return mockCategories.find((c) => c.slug === slug);
}

export function getMockSubcategories(categoryId?: string): Subcategory[] {
  let list = [...mockSubcategories].sort((a, b) => a.sort_order - b.sort_order);
  if (categoryId) list = list.filter((s) => s.category_id === categoryId);
  return list;
}

// ============================================================
// CMS 内容：site_settings / homepage_content / page_content
// 口径：B级防火 / E0级环保 / 不出现 A1、未确认 ISO/CARB、不强调实木
// ============================================================

// ---------- 站点设置（含扩展字段） ----------
export const mockSiteSettings: SiteSettings = {
  id: id("settings"),
  site_name: "KZQ Product Catalog",
  site_name_cn: "KZQ 工程级板材",
  site_name_en: "KZQ Engineering Boards",
  brand_name: "KZQ",
  default_language: "zh",
  global_meta_title_cn: "KZQ | 工程级板材·B级防火·E0环保饰面板",
  global_meta_title_en: "KZQ | Engineering Boards, B-Rated Fire & E0 Eco Panels",
  global_meta_description_cn:
    "KZQ 专注工程级板材、B 级防火与 E0 环保饰面板，服务国内工程精装与海外采购，支持规格定制与 FOB/CIF 出口。",
  global_meta_description_en:
    "KZQ specializes in engineering boards, B-rated fire and E0 eco panels for domestic projects and overseas procurement.",
  default_og_image_url: null,
  footer_text_cn: "© KZQ 工程级板材 · B级防火 · E0环保 · 国内工程与海外出口",
  footer_text_en: "© KZQ Engineering Boards · B-Rated Fire · E0 Eco · Domestic & Export",
  navigation_json: [
    { label_cn: "首页", label_en: "Home", href: "/", sort_order: 1 },
    { label_cn: "产品中心", label_en: "Products", href: "/products", sort_order: 2 },
    { label_cn: "资质证书", label_en: "Certificates", href: "/certificates", sort_order: 3 },
    { label_cn: "关于我们", label_en: "About", href: "/about", sort_order: 4 },
    { label_cn: "联系询盘", label_en: "Contact", href: "/contact", sort_order: 5 },
  ],
  // 旧字段保留（向后兼容）
  meta_title_cn: "KZQ | 工程级板材·B级防火·E0环保饰面板",
  meta_title_en: "KZQ | Engineering Boards, B-Rated Fire & E0 Eco Panels",
  meta_description_cn:
    "KZQ 专注工程级板材、B 级防火与 E0 环保饰面板，服务国内工程精装与海外采购，支持规格定制与 FOB/CIF 出口。",
  meta_description_en:
    "KZQ specializes in engineering boards, B-rated fire and E0 eco panels for domestic projects and overseas procurement.",
  updated_at: now,
};

// ---------- 首页内容（单例） ----------
const homeFeaturesCn: HomeFeatureItem[] = [
  { icon: "flame", title: "B 级防火", description: "第三方燃烧性能检测，达到 B 级防火标准" },
  { icon: "leaf", title: "E0 环保", description: "甲醛释放量达到 E0 级，适用于室内精装" },
  { icon: "truck", title: "工程交付", description: "稳定产能保障工程批量供货，规格可定制" },
  { icon: "globe", title: "海外出口", description: "支持集装箱 FOB/CIF 出口，多语言询盘响应" },
];
const homeFeaturesEn: HomeFeatureItem[] = [
  { icon: "flame", title: "B-Rated Fire", description: "Third-party tested to B-class fire performance" },
  { icon: "leaf", title: "E0 Eco", description: "E0 formaldehyde emission for interior use" },
  { icon: "truck", title: "Project Delivery", description: "Stable capacity for batch supply and custom sizes" },
  { icon: "globe", title: "Overseas Export", description: "FOB/CIF container export, multilingual inquiry" },
];

export const mockHomepageContent: HomepageContent = {
  id: id("homepage"),
  hero_eyebrow_cn: "Engineering Boards · Fire-Rated Decorative Panels",
  hero_eyebrow_en: "Engineering Boards · Fire-Rated Decorative Panels",
  hero_title_cn: "专注 B 级防火",
  hero_title_en: "B-Rated Fire & E0 Eco Engineering Boards",
  hero_highlight_cn: "E0 环保 工程板材",
  hero_highlight_en: "E0 Eco Engineering Boards",
  hero_description_cn:
    "KZQ 是工程级板材与装饰饰面板品牌供应商，服务国内工程精装与海外采购，覆盖防火板、饰面板、工程基材等多品类，支持规格定制与 FOB/CIF 出口。",
  hero_description_en:
    "KZQ is a brand supplier of engineering-grade boards and decorative panels, serving domestic projects and overseas buyers with B-rated fire and E0 eco solutions.",
  primary_cta_text_cn: "浏览产品",
  primary_cta_text_en: "Browse Products",
  secondary_cta_text_cn: "立即询盘",
  secondary_cta_text_en: "Get Quotation",
  feature_section_title_cn: "核心优势",
  feature_section_title_en: "Core Advantages",
  feature_section_subtitle_cn: "为什么选择 KZQ 工程级板材",
  feature_section_subtitle_en: "Why choose KZQ engineering boards",
  features_cn: homeFeaturesCn,
  features_en: homeFeaturesEn,
  category_section_title_cn: "产品类目",
  category_section_subtitle_cn: "按应用场景选择合适的板材",
  featured_products_title_cn: "主推产品",
  featured_products_subtitle_cn: "B 级防火 · E0 环保 · 工程批量供货",
  bottom_cta_title_cn: "联系 KZQ 获取报价",
  bottom_cta_title_en: "Contact KZQ for Quotation",
  bottom_cta_description_cn: "国内工程 · 海外采购 · 规格定制",
  bottom_cta_description_en: "Domestic projects · Overseas procurement · Custom specs",
  is_active: true,
  updated_at: now,
};

// ---------- 页面内容（about / certificates / contact / products） ----------
export const mockPageContents: PageContent[] = [
  {
    id: id("page-about"),
    page_key: "about",
    title_cn: "公司介绍",
    title_en: "About KZQ",
    subtitle_cn: "工程级板材品牌供应商",
    subtitle_en: "Engineering-Grade Board Brand Supplier",
    description_cn:
      "KZQ 专注于工程级板材与装饰饰面板，服务国内工程精装与海外采购，提供 B 级防火、E0 环保等级的高品质板材，支持规格定制与出口。",
    description_en:
      "KZQ specializes in engineering-grade boards and decorative panels, serving domestic projects and overseas buyers with B-rated fire and E0 eco solutions.",
    sections_cn: [
      { icon: "boxes", title: "产品能力", body: "提供工程级板材与装饰饰面板等多品类产品，规格可定制，详见产品中心。" },
      { icon: "shield", title: "品控能力", body: "建立完整品控流程，产品按公开的防火与环保等级交付，具体等级以产品详情与资质证书为准。" },
      { icon: "factory", title: "生产与交付能力", body: "稳定产能保障工程批量供货，支持定制规格生产，国内配送与海外出口并行。" },
      { icon: "globe", title: "国内与海外服务", body: "国内服务工程精装项目；海外支持多语言询盘响应，贸易条款与认证要求可在线咨询。" },
    ],
    sections_en: [
      { icon: "boxes", title: "Product Capability", body: "Multi-category engineering boards and decorative panels with custom sizes." },
      { icon: "shield", title: "Quality Control", body: "Full QC process; fire and eco grades per product detail and certificates." },
      { icon: "factory", title: "Production & Delivery", body: "Stable capacity for batch supply, custom sizes, domestic and export logistics." },
      { icon: "globe", title: "Domestic & Overseas", body: "Domestic project finishing; overseas multilingual inquiry and trade terms." },
    ],
    seo_title_cn: "KZQ 公司介绍 | 工程级板材品牌",
    seo_title_en: "About KZQ | Engineering Board Brand",
    seo_description_cn: "KZQ 公司介绍：产品能力、品控能力、生产与交付能力、面向国内与海外客户的服务能力。",
    seo_description_en: "KZQ company intro: product, quality, production & delivery, and domestic/overseas service capabilities.",
    updated_at: now,
  },
  {
    id: id("page-certificates"),
    page_key: "certificates",
    title_cn: "资质证书",
    title_en: "Certificates",
    subtitle_cn: "第三方检测认证 · 工程级品质保障",
    subtitle_en: "Third-party tested · Engineering-grade quality",
    description_cn: "KZQ 资质证书：已确认可公开展示的环保、防火及相关产品资料，完整证书请联系销售。",
    description_en: "KZQ certificates: confirmed public eco, fire and product documents. Full docs on request.",
    sections_cn: [],
    sections_en: [],
    seo_title_cn: "KZQ 资质证书 | B级防火 · E0环保",
    seo_title_en: "KZQ Certificates | B-Rated Fire & E0 Eco",
    seo_description_cn: "KZQ 资质证书：已确认可公开展示的环保、防火及相关产品资料，完整证书请联系销售。",
    seo_description_en: "KZQ certificates: confirmed public eco, fire and product documents.",
    updated_at: now,
  },
  {
    id: id("page-contact"),
    page_key: "contact",
    title_cn: "联系询盘",
    title_en: "Contact Us",
    subtitle_cn: "国内工程 · 海外采购 · 规格定制",
    subtitle_en: "Domestic projects · Overseas procurement · Custom specs",
    description_cn: "提交询盘表单获取专属报价，1 个工作日内回复；紧急需求可直接电话或 WhatsApp 联系。",
    description_en: "Submit an inquiry for a tailored quotation within 1 business day; urgent needs via phone or WhatsApp.",
    sections_cn: [],
    sections_en: [],
    seo_title_cn: "联系 KZQ | 获取产品报价",
    seo_title_en: "Contact KZQ | Get Quotation",
    seo_description_cn: "联系 KZQ 获取产品报价。支持电话、邮箱、WhatsApp、微信咨询，海外客户可直接提交询盘表单。",
    seo_description_en: "Contact KZQ for quotations. Phone, email, WhatsApp, WeChat supported; overseas buyers can submit inquiries online.",
    updated_at: now,
  },
  {
    id: id("page-products"),
    page_key: "products",
    title_cn: "产品中心",
    title_en: "Products",
    subtitle_cn: "工程级板材 · 防火饰面 · 海外出口",
    subtitle_en: "Engineering boards · Fire-rated panels · Export",
    description_cn: "KZQ 工程级板材产品中心，涵盖防火板、饰面板、工程基材等品类，支持规格定制与海外出口。",
    description_en: "KZQ engineering board product center: fire boards, decorative panels, engineering substrates, custom sizes and export.",
    sections_cn: [],
    sections_en: [],
    seo_title_cn: "KZQ 产品中心 | 工程级板材",
    seo_title_en: "KZQ Products | Engineering Boards",
    seo_description_cn: "KZQ 工程级板材产品中心：防火板、饰面板、工程基材，B 级防火、E0 环保，支持定制与出口。",
    seo_description_en: "KZQ engineering boards: fire boards, decorative panels, substrates. B-rated fire, E0 eco, custom and export.",
    updated_at: now,
  },
];

export function getMockHomepageContent(): HomepageContent {
  return mockHomepageContent;
}

export function getMockPageContent(pageKey: string): PageContent | null {
  return mockPageContents.find((p) => p.page_key === pageKey) || null;
}

export function getMockSiteSettings(): SiteSettings {
  return mockSiteSettings;
}

// 导航菜单（站点设置 navigation_json）
export function getMockNavigation(): NavItem[] {
  return mockSiteSettings.navigation_json || [];
}
