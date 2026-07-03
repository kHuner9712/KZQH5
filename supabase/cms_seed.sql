-- ============================================================
-- KZQ CMS 种子数据
-- 在 schema.sql + policies.sql（或 migrations/cms_upgrade.sql）+ seed.sql 之后执行
-- 内容：site_settings 扩展字段、homepage_content、page_content、products GEO 字段
-- 口径：B级防火 / E0级环保 / 不出现 A1、未确认 ISO/CARB、不强调实木
-- 幂等：使用 on conflict 或 update，可重复执行
-- ============================================================

-- ------------------------------------------------------------
-- 1. site_settings 扩展字段（更新已有单例行）
-- ------------------------------------------------------------
update public.site_settings set
  site_name_cn = 'KZQ 工程级板材',
  site_name_en = 'KZQ Engineering Boards',
  brand_name = 'KZQ',
  default_language = coalesce(default_language, 'zh'),
  global_meta_title_cn = 'KZQ | 工程级板材·B级防火·E0环保饰面板',
  global_meta_title_en = 'KZQ | Engineering Boards, B-Rated Fire & E0 Eco Panels',
  global_meta_description_cn = 'KZQ 专注工程级板材、B 级防火与 E0 环保饰面板，服务国内工程精装与海外采购，支持规格定制与 FOB/CIF 出口。',
  global_meta_description_en = 'KZQ specializes in engineering boards, B-rated fire and E0 eco panels for domestic projects and overseas procurement.',
  default_og_image_url = null,
  footer_text_cn = '© KZQ 工程级板材 · B级防火 · E0环保 · 国内工程与海外出口',
  footer_text_en = '© KZQ Engineering Boards · B-Rated Fire · E0 Eco · Domestic & Export',
  navigation_json = '[
    {"label_cn":"首页","label_en":"Home","href":"/","sort_order":1},
    {"label_cn":"产品中心","label_en":"Products","href":"/products","sort_order":2},
    {"label_cn":"资质证书","label_en":"Certificates","href":"/certificates","sort_order":3},
    {"label_cn":"关于我们","label_en":"About","href":"/about","sort_order":4},
    {"label_cn":"联系询盘","label_en":"Contact","href":"/contact","sort_order":5}
  ]'::jsonb,
  updated_at = now();

-- ------------------------------------------------------------
-- 2. homepage_content（单例，先清后插保证幂等）
-- ------------------------------------------------------------
delete from public.homepage_content;

insert into public.homepage_content (
  hero_eyebrow_cn, hero_eyebrow_en,
  hero_title_cn, hero_title_en,
  hero_highlight_cn, hero_highlight_en,
  hero_description_cn, hero_description_en,
  primary_cta_text_cn, primary_cta_text_en,
  secondary_cta_text_cn, secondary_cta_text_en,
  feature_section_title_cn, feature_section_title_en,
  feature_section_subtitle_cn, feature_section_subtitle_en,
  features_cn, features_en,
  category_section_title_cn, category_section_subtitle_cn,
  featured_products_title_cn, featured_products_subtitle_cn,
  bottom_cta_title_cn, bottom_cta_title_en,
  bottom_cta_description_cn, bottom_cta_description_en,
  is_active
) values (
  'Engineering Boards · Fire-Rated Decorative Panels',
  'Engineering Boards · Fire-Rated Decorative Panels',
  '专注 B 级防火',
  'B-Rated Fire & E0 Eco Engineering Boards',
  'E0 环保 工程板材',
  'E0 Eco Engineering Boards',
  'KZQ 是工程级板材与装饰饰面板品牌供应商，服务国内工程精装与海外采购，覆盖防火板、饰面板、工程基材等多品类，支持规格定制与 FOB/CIF 出口。',
  'KZQ is a brand supplier of engineering-grade boards and decorative panels, serving domestic projects and overseas buyers with B-rated fire and E0 eco solutions.',
  '浏览产品',
  'Browse Products',
  '立即询盘',
  'Get Quotation',
  '核心优势',
  'Core Advantages',
  '为什么选择 KZQ 工程级板材',
  'Why choose KZQ engineering boards',
  '[
    {"icon":"flame","title":"B 级防火","description":"第三方燃烧性能检测，达到 B 级防火标准"},
    {"icon":"leaf","title":"E0 环保","description":"甲醛释放量达到 E0 级，适用于室内精装"},
    {"icon":"truck","title":"工程交付","description":"稳定产能保障工程批量供货，规格可定制"},
    {"icon":"globe","title":"海外出口","description":"支持集装箱 FOB/CIF 出口，多语言询盘响应"}
  ]'::jsonb,
  '[
    {"icon":"flame","title":"B-Rated Fire","description":"Third-party tested to B-class fire performance"},
    {"icon":"leaf","title":"E0 Eco","description":"E0 formaldehyde emission for interior use"},
    {"icon":"truck","title":"Project Delivery","description":"Stable capacity for batch supply and custom sizes"},
    {"icon":"globe","title":"Overseas Export","description":"FOB/CIF container export, multilingual inquiry"}
  ]'::jsonb,
  '产品类目',
  '按应用场景选择合适的板材',
  '主推产品',
  'B 级防火 · E0 环保 · 工程批量供货',
  '联系 KZQ 获取报价',
  'Contact KZQ for Quotation',
  '国内工程 · 海外采购 · 规格定制',
  'Domestic projects · Overseas procurement · Custom specs',
  true
);

-- ------------------------------------------------------------
-- 3. page_content（about / certificates / contact / products）
-- ------------------------------------------------------------
delete from public.page_content;

insert into public.page_content (page_key, title_cn, title_en, subtitle_cn, subtitle_en, description_cn, description_en, sections_cn, sections_en, seo_title_cn, seo_title_en, seo_description_cn, seo_description_en) values
(
  'about',
  '公司介绍',
  'About KZQ',
  '工程级板材品牌供应商',
  'Engineering-Grade Board Brand Supplier',
  'KZQ 专注于工程级板材与装饰饰面板，服务国内工程精装与海外采购，提供 B 级防火、E0 环保等级的高品质板材，支持规格定制与出口。',
  'KZQ specializes in engineering-grade boards and decorative panels, serving domestic projects and overseas buyers with B-rated fire and E0 eco solutions.',
  '[
    {"icon":"boxes","title":"产品能力","body":"提供工程级板材与装饰饰面板等多品类产品，规格可定制，详见产品中心。"},
    {"icon":"shield","title":"品控能力","body":"建立完整品控流程，产品按公开的防火与环保等级交付，具体等级以产品详情与资质证书为准。"},
    {"icon":"factory","title":"生产与交付能力","body":"稳定产能保障工程批量供货，支持定制规格生产，国内配送与海外出口并行。"},
    {"icon":"globe","title":"国内与海外服务","body":"国内服务工程精装项目；海外支持多语言询盘响应，贸易条款与认证要求可在线咨询。"}
  ]'::jsonb,
  '[
    {"icon":"boxes","title":"Product Capability","body":"Multi-category engineering boards and decorative panels with custom sizes."},
    {"icon":"shield","title":"Quality Control","body":"Full QC process; fire and eco grades per product detail and certificates."},
    {"icon":"factory","title":"Production & Delivery","body":"Stable capacity for batch supply, custom sizes, domestic and export logistics."},
    {"icon":"globe","title":"Domestic & Overseas","body":"Domestic project finishing; overseas multilingual inquiry and trade terms."}
  ]'::jsonb,
  'KZQ 公司介绍 | 工程级板材品牌',
  'About KZQ | Engineering Board Brand',
  'KZQ 公司介绍：产品能力、品控能力、生产与交付能力、面向国内与海外客户的服务能力。',
  'KZQ company intro: product, quality, production & delivery, and domestic/overseas service capabilities.'
),
(
  'certificates',
  '资质证书',
  'Certificates',
  '第三方检测认证 · 工程级品质保障',
  'Third-party tested · Engineering-grade quality',
  'KZQ 资质证书：已确认可公开展示的环保、防火及相关产品资料，完整证书请联系销售。',
  'KZQ certificates: confirmed public eco, fire and product documents. Full docs on request.',
  '[]'::jsonb,
  '[]'::jsonb,
  'KZQ 资质证书 | B级防火 · E0环保',
  'KZQ Certificates | B-Rated Fire & E0 Eco',
  'KZQ 资质证书：已确认可公开展示的环保、防火及相关产品资料，完整证书请联系销售。',
  'KZQ certificates: confirmed public eco, fire and product documents.'
),
(
  'contact',
  '联系询盘',
  'Contact Us',
  '国内工程 · 海外采购 · 规格定制',
  'Domestic projects · Overseas procurement · Custom specs',
  '提交询盘表单获取专属报价，1 个工作日内回复；紧急需求可直接电话或 WhatsApp 联系。',
  'Submit an inquiry for a tailored quotation within 1 business day; urgent needs via phone or WhatsApp.',
  '[]'::jsonb,
  '[]'::jsonb,
  '联系 KZQ | 获取产品报价',
  'Contact KZQ | Get Quotation',
  '联系 KZQ 获取产品报价。支持电话、邮箱、WhatsApp、微信咨询，海外客户可直接提交询盘表单。',
  'Contact KZQ for quotations. Phone, email, WhatsApp, WeChat supported; overseas buyers can submit inquiries online.'
),
(
  'products',
  '产品中心',
  'Products',
  '工程级板材 · 防火饰面 · 海外出口',
  'Engineering boards · Fire-rated panels · Export',
  'KZQ 工程级板材产品中心，涵盖防火板、饰面板、工程基材等品类，支持规格定制与海外出口。',
  'KZQ engineering board product center: fire boards, decorative panels, engineering substrates, custom sizes and export.',
  '[]'::jsonb,
  '[]'::jsonb,
  'KZQ 产品中心 | 工程级板材',
  'KZQ Products | Engineering Boards',
  'KZQ 工程级板材产品中心：防火板、饰面板、工程基材，B 级防火、E0 环保，支持定制与出口。',
  'KZQ engineering boards: fire boards, decorative panels, substrates. B-rated fire, E0 eco, custom and export.'
);

-- ------------------------------------------------------------
-- 4. products GEO / SEO 字段（为 seed.sql 中的 8 个产品补齐 GEO 内容）
-- 口径：B级防火 / E0环保 / 无实木/A1/未确认认证
-- ------------------------------------------------------------
update public.products set
  seo_title_cn = 'KZQ 工程级多层板 18mm | B级防火 E0环保',
  seo_description_cn = 'KZQ 工程级多层板，结构稳定，B 级防火，E0 环保，适用于高端定制家具与工程精装，支持定制规格与海外出口。',
  geo_summary_cn = 'KZQ 工程级多层板面向国内工程精装与海外采购，B 级防火、E0 环保，规格可定制，FOB/CIF 出口。',
  keywords_cn = ARRAY['工程多层板','B级防火板','E0环保板','工程基材','海外出口板材'],
  keywords_en = ARRAY['engineering board','B-rated fire board','E0 eco board','engineering substrate','export board'],
  faq_cn = '[
    {"question":"KZQ 工程级多层板适合哪些应用？","answer":"适用于高端定制家具、酒店精装、展柜等工程应用。"},
    {"question":"防火与环保等级是什么？","answer":"B 级防火，E0 级环保，具体以产品详情与资质证书为准。"}
  ]'::jsonb
where slug = 'kzq-engineering-multi-layer-board-18mm';

update public.products set
  seo_title_cn = 'KZQ 高密度 MDF 15mm | B级防火 E0环保',
  seo_description_cn = 'KZQ 高密度 MDF 中密度板，密度均匀，板面平整，B 级防火，E0 环保，适合雕刻、吸塑、烤漆等二次加工。',
  geo_summary_cn = 'KZQ 高密度 MDF 面向定制家具与门板应用，B 级防火、E0 环保，规格齐全可定制。',
  keywords_cn = ARRAY['高密度MDF','中密度板','B级防火板','E0环保板','工程基材'],
  keywords_en = ARRAY['high-density MDF','MDF board','B-rated fire board','E0 eco board','engineering substrate'],
  faq_cn = '[
    {"question":"KZQ 高密度 MDF 适合哪些加工？","answer":"适合雕刻、吸塑、烤漆等二次加工，是定制家具与门板的理想基材。"},
    {"question":"是否支持海外出口？","answer":"支持，可按海外客户规格生产，FOB/CIF 条款灵活。"}
  ]'::jsonb
where slug = 'kzq-high-density-mdf-15mm';

update public.products set
  seo_title_cn = 'KZQ 三聚氰胺饰面板 木纹系列 | B级 E0',
  seo_description_cn = 'KZQ 三聚氰胺饰面板木纹系列，木纹逼真，耐磨抗刮，B 级防火，E0 环保，适用于全屋定制柜体与办公家具。',
  geo_summary_cn = 'KZQ 三聚氰胺饰面板木纹系列面向全屋定制与办公家具，B 级防火、E0 环保，花色可定制。',
  keywords_cn = ARRAY['三聚氰胺饰面板','木纹饰面板','B级防火饰面板','E0环保饰面板','定制饰面板'],
  keywords_en = ARRAY['melamine faced panel','wood grain panel','B-rated fire panel','E0 eco panel','custom decorative panel'],
  faq_cn = '[
    {"question":"KZQ 三聚氰胺饰面板可以定制花色吗？","answer":"可以，支持多种纹理与色彩定制，工程批量供货。"},
    {"question":"防火与环保等级？","answer":"B 级防火，E0 级环保。"}
  ]'::jsonb
where slug = 'kzq-melamine-faced-panel-wood-grain';

update public.products set
  seo_title_cn = 'KZQ UV 高光涂装板 | B级 E0',
  seo_description_cn = 'KZQ UV 高光涂装板，漆膜硬度高，光泽度佳，耐黄变，B 级防火，E0 环保，适用于现代风格衣柜门板与商业展示。',
  geo_summary_cn = 'KZQ UV 高光涂装板面向现代风格家具与商业展示，B 级防火、E0 环保，光泽持久。',
  keywords_cn = ARRAY['UV涂装板','高光板','B级防火板','E0环保板','衣柜门板'],
  keywords_en = ARRAY['UV coated panel','high-gloss panel','B-rated fire panel','E0 eco panel','wardrobe door panel'],
  faq_cn = '[
    {"question":"UV 高光板容易黄变吗？","answer":"采用 UV 固化涂料，耐黄变，光泽持久。"}
  ]'::jsonb
where slug = 'kzq-uv-high-gloss-coated-panel';

update public.products set
  seo_title_cn = 'KZQ 玻镁防火板 12mm | B级防火',
  seo_description_cn = 'KZQ 玻镁防火板 12mm，B 级防火，遇火不燃，无有毒烟雾，适用于酒店、商场、医院等公共场所隔墙与吊顶。',
  geo_summary_cn = 'KZQ 玻镁防火板面向公共场所防火饰面工程，B 级防火，可定制规格，支持国内配送与海外出口。',
  keywords_cn = ARRAY['玻镁防火板','B级防火板','防火基材','工程防火板','海外出口防火板'],
  keywords_en = ARRAY['magnesium fire board','B-rated fire board','fire substrate','engineering fire board','export fire board'],
  faq_cn = '[
    {"question":"KZQ 玻镁防火板适合哪些应用？","answer":"适用于酒店、商场、医院等公共场所隔墙与吊顶的防火饰面工程。"},
    {"question":"防火等级是多少？","answer":"B 级防火，遇火不燃，无有毒烟雾。"},
    {"question":"是否支持海外出口？","answer":"支持，全国配送 / 海外集装箱 FOB / CIF。"}
  ]'::jsonb
where slug = 'kzq-mgo-fire-board-12mm';

update public.products set
  seo_title_cn = 'KZQ 防火饰面板 工程定制 | B级 E0',
  seo_description_cn = 'KZQ 防火饰面板，防火基材与装饰饰面一体化，B 级防火，E0 环保，可定制花色与尺寸，适用于大型公共工程。',
  geo_summary_cn = 'KZQ 防火饰面板面向地铁、机场、学校等大型公共工程，B 级防火、E0 环保，可定制花色与尺寸。',
  keywords_cn = ARRAY['防火饰面板','工程定制板','B级防火饰面板','E0环保饰面板','公共工程板材'],
  keywords_en = ARRAY['fire-rated decorative panel','custom engineering panel','B-rated fire panel','E0 eco panel','public project panel'],
  faq_cn = '[
    {"question":"KZQ 防火饰面板适合哪些工程？","answer":"适用于地铁、机场、学校、商业综合体等大型公共工程。"},
    {"question":"可以定制花色与尺寸吗？","answer":"可以，花色与尺寸均可按工程需求定制。"}
  ]'::jsonb
where slug = 'kzq-fire-rated-decorative-panel-custom';

update public.products set
  seo_title_cn = 'KZQ 海外出口级多层板 17mm | B级 E0',
  seo_description_cn = 'KZQ 海外出口级多层板 17mm，符合 E0 标准，含水率与胶合强度满足国际海运要求，可定制尺寸与包装，支持 FOB/CIF。',
  geo_summary_cn = 'KZQ 海外出口级多层板面向海外家具制造与工程承包商，B 级防火、E0 环保，支持 FOB/CIF 出口。',
  keywords_cn = ARRAY['出口级多层板','海外出口板材','B级防火板','E0环保板','FOB CIF板材'],
  keywords_en = ARRAY['export-grade board','overseas export board','B-rated fire board','E0 eco board','FOB CIF board'],
  faq_cn = '[
    {"question":"出口贸易条款？","answer":"FOB 宁波 / CIF 可协商，可定制尺寸与包装。"},
    {"question":"最小起订量？","answer":"1×20GP 集装箱起订，具体可咨询销售。"}
  ]'::jsonb
where slug = 'kzq-export-grade-multi-layer-board-17mm';

update public.products set
  seo_title_cn = 'KZQ 素色三聚氰胺板 哑光系列 | B级 E0',
  seo_description_cn = 'KZQ 素色三聚氰胺板哑光系列，多种莫兰迪色系，哑光触感细腻，抗指纹易清洁，B 级防火，E0 环保。',
  geo_summary_cn = 'KZQ 素色三聚氰胺板哑光系列面向现代极简风格家具与空间，B 级防火、E0 环保，色彩可定制。',
  keywords_cn = ARRAY['素色三聚氰胺板','哑光饰面板','B级防火饰面板','E0环保饰面板','现代风格板材'],
  keywords_en = ARRAY['solid color melamine panel','matte panel','B-rated fire panel','E0 eco panel','modern style panel'],
  faq_cn = '[
    {"question":"哑光系列有哪些颜色？","answer":"提供多种莫兰迪色系选择，可按需求定制色彩。"}
  ]'::jsonb
where slug = 'kzq-solid-color-melamine-matte';
