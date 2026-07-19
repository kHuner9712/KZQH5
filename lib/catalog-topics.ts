import type { ProductAsset } from "@/types/database";

export type CatalogTopicSection = "catalogs" | "systems" | "finishes";

export interface CatalogTopic {
  id: string;
  section: CatalogTopicSection;
  titleCn: string;
  titleEn: string;
  descriptionCn: string;
  descriptionEn: string;
  aliases: string[];
}

export const catalogTopicSections: Array<{
  id: CatalogTopicSection;
  titleCn: string;
  titleEn: string;
  descriptionCn: string;
  descriptionEn: string;
}> = [
  {
    id: "catalogs",
    titleCn: "综合目录与色卡",
    titleEn: "Catalogs & Color Cards",
    descriptionCn: "用于选型、报价沟通和项目方案确认的综合产品资料。",
    descriptionEn: "Core product references for selection, quotation and project planning.",
  },
  {
    id: "systems",
    titleCn: "产品系统与配套",
    titleEn: "Product Systems & Accessories",
    descriptionCn: "墙板、门、地板、型材、线条及安装收边系统资料。",
    descriptionEn: "Wall panels, doors, flooring, profiles, trims and finishing systems.",
  },
  {
    id: "finishes",
    titleCn: "饰面系列",
    titleEn: "Decorative Finishes",
    descriptionCn: "木纹、石纹、金属、纯色和布纹等饰面选型资料。",
    descriptionEn: "Wood, stone, metal, solid-color and fabric finish references.",
  },
];

export const catalogTopics: CatalogTopic[] = [
  {
    id: "color-card",
    section: "catalogs",
    titleCn: "KZQ 综合色卡",
    titleEn: "KZQ Color Card",
    descriptionCn: "综合色号、纹理与表面效果选型参考。",
    descriptionEn: "Color, texture and surface-finish selection reference.",
    aliases: ["BJX Color Card", "Color Card", "综合色卡", "色卡"],
  },
  {
    id: "gz-series",
    section: "catalogs",
    titleCn: "GZ 系列目录",
    titleEn: "GZ Series Catalog",
    descriptionCn: "GZ 系列型号、饰面与应用方案。",
    descriptionEn: "GZ series models, finishes and application options.",
    aliases: ["BJX GZ Series", "GZ Series", "GZ 系列"],
  },
  {
    id: "hd-spc-catalog",
    section: "catalogs",
    titleCn: "HD / SPC 产品目录",
    titleEn: "HD / SPC Catalog",
    descriptionCn: "HD 与 SPC 板材的系列、规格和饰面资料。",
    descriptionEn: "HD and SPC panel ranges, specifications and finishes.",
    aliases: ["HD / SPC Catalog", "HD SPC Catalog", "HD / SPC 产品目录"],
  },
  {
    id: "product-information-book",
    section: "catalogs",
    titleCn: "产品信息手册",
    titleEn: "Product Information Book",
    descriptionCn: "产品体系、规格参数、应用与采购信息汇总。",
    descriptionEn: "Product range, specifications, applications and procurement overview.",
    aliases: ["Product Information Book", "产品信息手册", "产品手册"],
  },
  {
    id: "wpc-wall-panel",
    section: "catalogs",
    titleCn: "WPC 墙板综合目录",
    titleEn: "WPC Wall Panel Catalog",
    descriptionCn: "WPC 墙板系列、结构、尺寸和应用场景。",
    descriptionEn: "WPC wall panel ranges, structures, sizes and applications.",
    aliases: ["WPC Wall Panel", "WPC 墙板", "墙板综合目录"],
  },
  {
    id: "wpc-solid-splicing",
    section: "systems",
    titleCn: "WPC 墙板与实心拼接板",
    titleEn: "WPC Wall Panel & Solid Splicing Board",
    descriptionCn: "墙板与实心拼接板的组合应用及规格参考。",
    descriptionEn: "Combined wall-panel and solid-splicing-board applications and sizes.",
    aliases: ["WPC Wall Panel & WPC Solid Splicing Board", "WPC Solid Splicing Board", "实心拼接板"],
  },
  {
    id: "wpc-door-series",
    section: "systems",
    titleCn: "WPC 门系列",
    titleEn: "WPC Door Series",
    descriptionCn: "WPC 门板、门套、饰面与配套方案。",
    descriptionEn: "WPC door panels, frames, finishes and matching systems.",
    aliases: ["WPC Door Series", "WPC 门系列", "WPC 门"],
  },
  {
    id: "carbon-crystal-wall-panel",
    section: "systems",
    titleCn: "碳晶墙板增强系列",
    titleEn: "Carbon Crystal Wall Panel Plus",
    descriptionCn: "碳晶墙板结构、饰面和室内工程应用资料。",
    descriptionEn: "Carbon-crystal panel construction, finishes and interior applications.",
    aliases: ["Carbon Crystal Wall Panel Plus", "Carbon Crystal Wall Panel", "碳晶墙板"],
  },
  {
    id: "anti-collision-wall-panel",
    section: "systems",
    titleCn: "防撞墙板",
    titleEn: "Anti-Collision Wall Panel",
    descriptionCn: "公共空间与工程区域防撞墙面系统资料。",
    descriptionEn: "Impact-resistant wall systems for public and project spaces.",
    aliases: ["Anti-Collision Wall Panel", "Anti Collision Wall Panel", "防撞墙板"],
  },
  {
    id: "fireproof-wall-panel",
    section: "systems",
    titleCn: "防火墙板",
    titleEn: "Fireproof Wall Panel",
    descriptionCn: "防火墙板产品结构、规格与公开性能资料。",
    descriptionEn: "Fire-resistant wall panel structures, sizes and published performance data.",
    aliases: ["Fireproof Wall Panel", "Fire Proof Wall Panel", "防火墙板"],
  },
  {
    id: "aluminum-alloy-profile",
    section: "systems",
    titleCn: "铝合金墙板型材",
    titleEn: "Aluminum Alloy Wallboard Profile",
    descriptionCn: "墙板连接、收边、转角和装饰型材资料。",
    descriptionEn: "Joining, edging, corner and decorative profile references.",
    aliases: ["Aluminum Alloy Wallboard Profile", "Aluminium Alloy Wallboard Profile", "铝合金墙板型材"],
  },
  {
    id: "sound-absorption-grille",
    section: "systems",
    titleCn: "吸音格栅板系列",
    titleEn: "Sound Absorption Panel Grille Series",
    descriptionCn: "吸音格栅板结构、饰面和空间应用资料。",
    descriptionEn: "Acoustic grille-panel structures, finishes and spatial applications.",
    aliases: ["Sound Absorption Panel Grille Series", "Acoustic Grille Panel", "吸音格栅板"],
  },
  {
    id: "soft-stone-series",
    section: "systems",
    titleCn: "软石系列",
    titleEn: "Soft Stone Series",
    descriptionCn: "柔性软石纹理、规格和墙面应用资料。",
    descriptionEn: "Flexible soft-stone textures, sizes and wall applications.",
    aliases: ["Soft Stone Series", "Soft Stone", "软石系列", "柔性石材"],
  },
  {
    id: "spc-wpc-flooring",
    section: "systems",
    titleCn: "SPC 与 WPC 地板",
    titleEn: "SPC & WPC Flooring",
    descriptionCn: "SPC/WPC 地板结构、花色、规格和包装参考。",
    descriptionEn: "SPC/WPC flooring structures, finishes, sizes and packaging.",
    aliases: ["SPC & WPC Flooring", "SPC WPC Flooring", "SPC 与 WPC 地板"],
  },
  {
    id: "edge-finishing",
    section: "systems",
    titleCn: "格栅墙板收边方案",
    titleEn: "Fluted Wall Panel Edge Finishing Solutions",
    descriptionCn: "阴阳角、起收口、拼接和边缘处理方案。",
    descriptionEn: "Internal corners, external corners, joints and edge-finishing solutions.",
    aliases: ["Fluted Wall Panel Edge Finishing Solutions", "Edge Finishing Solutions", "格栅墙板收边"],
  },
  {
    id: "wpc-lines",
    section: "systems",
    titleCn: "WPC 装饰线条",
    titleEn: "WPC Lines",
    descriptionCn: "装饰线条、收边条、连接条和配套型材资料。",
    descriptionEn: "Decorative lines, trims, connectors and matching profiles.",
    aliases: ["WPC Lines", "WPC Line", "WPC 装饰线条", "WPC 线条"],
  },
  {
    id: "wood-grain",
    section: "finishes",
    titleCn: "木纹墙板饰面",
    titleEn: "WPC Wall Panel - Wood Grain",
    descriptionCn: "木纹花色、纹理方向和空间搭配参考。",
    descriptionEn: "Wood-grain colors, texture direction and interior coordination.",
    aliases: ["WPC Wall Panel-Wood Grain", "WPC Wall Panel - Wood Grain", "Wood Grain", "木纹墙板"],
  },
  {
    id: "metal-series",
    section: "finishes",
    titleCn: "金属纹墙板饰面",
    titleEn: "WPC Wall Panel - Metal Series",
    descriptionCn: "金属质感、拉丝与现代工程饰面参考。",
    descriptionEn: "Metallic, brushed and modern project-finish references.",
    aliases: ["WPC Wall Panel-Metal Series", "WPC Wall Panel - Metal Series", "Metal Series", "金属纹墙板"],
  },
  {
    id: "stone-grain",
    section: "finishes",
    titleCn: "石纹墙板饰面",
    titleEn: "WPC Wall Panel - Stone Grain",
    descriptionCn: "大理石、岩板及天然石材视觉效果参考。",
    descriptionEn: "Marble, sintered-stone and natural-stone visual references.",
    aliases: ["WPC Wall Panel-Stone Grain", "WPC Wall Panel - Stone Grain", "Stone Grain", "石纹墙板"],
  },
  {
    id: "solid-color",
    section: "finishes",
    titleCn: "纯色墙板饰面",
    titleEn: "WPC Wall Panel - Solid Color",
    descriptionCn: "中性色、低饱和色及工程定制色参考。",
    descriptionEn: "Neutral, muted and project-custom solid-color references.",
    aliases: ["WPC Wall Panel-Solid Color", "WPC Wall Panel - Solid Color", "Solid Color", "纯色墙板"],
  },
  {
    id: "cloth-grain",
    section: "finishes",
    titleCn: "布纹墙板饰面",
    titleEn: "WPC Wall Panel - Cloth Grain",
    descriptionCn: "织物、亚麻和软装质感饰面参考。",
    descriptionEn: "Fabric, linen and soft-furnishing texture references.",
    aliases: ["WPC Wall Panel-Cloth Grain", "WPC Wall Panel - Cloth Grain", "Cloth Grain", "布纹墙板"],
  },
];

function normalizeCatalogText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

export function findCatalogTopicAsset(
  topic: CatalogTopic,
  assets: ProductAsset[],
): ProductAsset | null {
  const aliases = [topic.titleCn, topic.titleEn, ...topic.aliases]
    .map(normalizeCatalogText)
    .filter(Boolean);

  return (
    assets.find((asset) => {
      const values = [
        asset.title_cn,
        asset.title_en || "",
        asset.description_cn || "",
        asset.description_en || "",
      ]
        .map(normalizeCatalogText)
        .filter(Boolean);

      return values.some((value) =>
        aliases.some(
          (alias) =>
            value === alias ||
            (alias.length >= 5 && value.includes(alias)) ||
            (value.length >= 5 && alias.includes(value)),
        ),
      );
    }) || null
  );
}
