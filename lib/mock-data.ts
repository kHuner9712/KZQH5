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
    description_cn: "玻镁基材防火板，A1/B 级防火。",
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
export const mockProducts: Product[] = [
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
    name_cn: "工厂品控能力评估",
    name_en: "Factory Quality Control Assessment",
    description_cn: "工厂品控流程与出货检验能力评估（展示版）。",
    description_en: "Factory QC process and pre-shipment inspection (display version).",
    image_url: null,
    applicable_scope_cn: "全厂品控体系",
    applicable_scope_en: "Plant quality control system",
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
