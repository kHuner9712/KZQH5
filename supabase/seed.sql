-- ============================================================
-- KZQ 品牌 H5 - 种子数据
-- 在执行完 schema.sql + policies.sql 后执行
-- ============================================================

-- 先清空（注意顺序，避免外键冲突）
delete from public.product_images;
delete from public.products;
delete from public.subcategories;
delete from public.categories;
delete from public.certificates;
delete from public.inquiries;
delete from public.company_profile;
delete from public.site_settings;

-- ============================================================
-- 一级类目（3 个）
-- ============================================================
insert into public.categories (id, name_cn, name_en, slug, description_cn, description_en, sort_order, is_active) values
('11111111-1111-1111-1111-111111111101', '板材系列', 'Board Series', 'boards', 'KZQ 核心板材产品线，覆盖多层板、密度板、颗粒板等工程基材。', 'Core board product line covering engineering substrates.', 1, true),
('11111111-1111-1111-1111-111111111102', '装饰板系列', 'Decorative Panel Series', 'decorative-panels', '表面装饰饰面板材，适用于家具、室内空间精装。', 'Surface decorative panels for furniture and interior finishing.', 2, true),
('11111111-1111-1111-1111-111111111103', '防火板系列', 'Fire-Rated Panel Series', 'fire-rated-panels', 'B级防火等级工程板材，适用于公共空间与商业项目。', 'B-rated fire-resistant panels for public and commercial projects.', 3, true);

-- ============================================================
-- 二级类目（每个一级类目 2 个）
-- ============================================================
insert into public.subcategories (id, category_id, name_cn, name_en, slug, description_cn, description_en, sort_order, is_active) values
('22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111101', '多层实木板', 'Multi-Layer Solid Board', 'multi-layer-solid-board', '结构稳定的多层实木基材。', 'Stable multi-layer solid substrate.', 1, true),
('22222222-2222-2222-2222-222222222202', '11111111-1111-1111-1111-111111111101', '中密度纤维板', 'MDF Board', 'mdf-board', '高密度中密度板，表面平整易加工。', 'High-density MDF with smooth surface.', 2, true),
('22222222-2222-2222-2222-222222222203', '11111111-1111-1111-1111-111111111102', '三聚氰胺饰面板', 'Melamine Faced Panel', 'melamine-faced-panel', '耐磨饰面板，花色丰富。', 'Wear-resistant decorative panel.', 1, true),
('22222222-2222-2222-2222-222222222204', '11111111-1111-1111-1111-111111111102', 'UV 涂装板', 'UV Coated Panel', 'uv-coated-panel', 'UV 固化涂装，高光哑光可选。', 'UV cured coating, gloss or matte.', 2, true),
('22222222-2222-2222-2222-222222222205', '11111111-1111-1111-1111-111111111103', '玻镁防火板', 'Magnesium Oxide Fire Board', 'mgo-fire-board', 'A1/B1 级防火基材，适用于隔墙吊顶。', 'A1/B1 fire substrate for partitions and ceilings.', 1, true),
('22222222-2222-2222-2222-222222222206', '11111111-1111-1111-1111-111111111103', '防火饰面板', 'Fire-Rated Decorative Panel', 'fire-rated-decorative-panel', '防火 + 装饰一体化饰面板。', 'Fire-rated decorative integrated panel.', 2, true);

-- ============================================================
-- 产品（8 个） - 围绕板材/装饰/防火/E0环保/工程/海外采购
-- 默认 fire_rating=B级, eco_grade=E0级
-- 价格字段统一为"请联系销售获取报价"
-- ============================================================
insert into public.products (
  id, category_id, subcategory_id, name_cn, name_en, slug,
  summary_cn, summary_en, description_cn, description_en,
  material_cn, material_en, size, fire_rating, eco_grade,
  price_display_cn, price_display_en, moq,
  packaging_cn, packaging_en, logistics_cn, logistics_en,
  application_cn, application_en, video_url, cover_image_url,
  is_featured, is_published, sort_order
) values
(
  '33333333-3333-3333-3333-333333333301',
  '11111111-1111-1111-1111-111111111101',
  '22222222-2222-2222-2222-222222222201',
  'KZQ 工程级多层实木板 18mm', 'KZQ Engineering Multi-Layer Solid Board 18mm', 'kzq-engineering-multi-layer-board-18mm',
  '18mm 多层实木基材，结构稳定，E0 级环保。', '18mm multi-layer solid substrate, stable structure, E0 eco grade.',
  'KZQ 工程级多层实木板采用优质原木单板交叉层压而成，含水率控制稳定，握钉力强，适用于高端定制家具与工程精装项目。通过 E0 级环保检测，甲醛释放量≤0.05mg/m³。',
  'KZQ engineering multi-layer solid board is cross-laminated from premium veneer with stable moisture content and strong nail holding. E0 grade formaldehyde emission ≤0.05mg/m³.',
  '优质杨木/桉木单板', 'Premium poplar/eucalyptus veneer',
  '2440×1220×18mm', 'B级', 'E0级',
  '请联系销售获取报价', 'Contact for quotation', '100 张',
  '托盘打包，覆膜防潮', 'Pallet packed, film-wrapped',
  '国内整车 / 海外集装箱可发', 'Domestic truck / overseas container available',
  '高端定制家具、酒店精装、展柜', 'Custom furniture, hotel finishing, display cabinets',
  '', 'https://images.unsplash.com/photo-1604147706283-d7119b5b822c?w=800',
  'https://images.unsplash.com/photo-1604147706283-d7119b5b822c?w=800',
  true, true, 1
),
(
  '33333333-3333-3333-3333-333333333302',
  '11111111-1111-1111-1111-111111111101',
  '22222222-2222-2222-2222-222222222202',
  'KZQ 高密度 MDF 中密度板 15mm', 'KZQ High-Density MDF Board 15mm', 'kzq-high-density-mdf-15mm',
  '15mm 高密度 MDF，表面平整，易加工。', '15mm high-density MDF, smooth surface, easy processing.',
  'KZQ 高密度 MDF 选用细木纤维高温高压成型，密度均匀，板面平整，适合雕刻、吸塑、烤漆等二次加工，是定制家具与门板的理想基材。',
  'KZQ high-density MDF is made of fine wood fiber under high temperature and pressure, uniform density and smooth surface, ideal for carving, thermoforming and painting.',
  '细木纤维', 'Fine wood fiber',
  '2440×1220×15mm', 'B级', 'E0级',
  '请联系销售获取报价', 'Contact for quotation', '150 张',
  '托盘打包', 'Pallet packed',
  '支持全国配送与海外出口', 'Nationwide delivery and overseas export',
  '定制家具、门板、展示架', 'Custom furniture, door panels, display racks',
  '', 'https://images.unsplash.com/photo-1581094794329-c8112a89af12?w=800',
  'https://images.unsplash.com/photo-1581094794329-c8112a89af12?w=800',
  true, true, 2
),
(
  '33333333-3333-3333-3333-333333333303',
  '11111111-1111-1111-1111-111111111102',
  '22222222-2222-2222-2222-222222222203',
  'KZQ 三聚氰胺饰面板 木纹系列', 'KZQ Melamine Faced Panel Wood Grain', 'kzq-melamine-faced-panel-wood-grain',
  '木纹三聚氰胺饰面，耐磨易清洁。', 'Wood grain melamine surface, wear-resistant and easy clean.',
  'KZQ 三聚氰胺饰面板采用进口饰面纸与环保基材热压成型，木纹逼真，耐磨抗刮，适用于全屋定制柜体与办公家具。E0 级环保，B 级防火。',
  'KZQ melamine faced panel uses imported decorative paper and eco substrate, realistic wood grain, scratch-resistant. E0 grade, B-rated fire.',
  '三聚氰胺饰面纸 + 环保基材', 'Melamine paper + eco substrate',
  '2440×1220×18mm', 'B级', 'E0级',
  '请联系销售获取报价', 'Contact for quotation', '200 张',
  '托盘打包，四角护角', 'Pallet packed with corner protectors',
  '国内整车 / 海外整柜', 'Domestic truck / overseas container',
  '全屋定制柜体、办公家具', 'Whole-house cabinets, office furniture',
  '', 'https://images.unsplash.com/photo-1567016432779-094069958ea5?w=800',
  'https://images.unsplash.com/photo-1567016432779-094069958ea5?w=800',
  false, true, 3
),
(
  '33333333-3333-3333-3333-333333333304',
  '11111111-1111-1111-1111-111111111102',
  '22222222-2222-2222-2222-222222222204',
  'KZQ UV 高光涂装板', 'KZQ UV High-Gloss Coated Panel', 'kzq-uv-high-gloss-coated-panel',
  'UV 固化高光涂装，镜面效果。', 'UV cured high-gloss coating, mirror effect.',
  'KZQ UV 高光涂装板采用 UV 固化涂料辊涂，漆膜硬度高，光泽度佳，耐黄变，适用于现代风格衣柜门板与商业展示空间。',
  'KZQ UV high-gloss panel uses UV cured coating with high hardness, excellent gloss and anti-yellowing.',
  'UV 涂料 + 环保基材', 'UV coating + eco substrate',
  '2440×1220×18mm', 'B级', 'E0级',
  '请联系销售获取报价', 'Contact for quotation', '120 张',
  '托盘打包，板间垫片', 'Pallet packed with separators',
  '国内配送 / 海外出口', 'Domestic delivery / overseas export',
  '衣柜门板、商业展示墙', 'Wardrobe doors, commercial display walls',
  '', 'https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=800',
  'https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=800',
  true, true, 4
),
(
  '33333333-3333-3333-3333-333333333305',
  '11111111-1111-1111-1111-111111111103',
  '22222222-2222-2222-2222-222222222205',
  'KZQ 玻镁防火板 12mm', 'KZQ Magnesium Oxide Fire Board 12mm', 'kzq-mgo-fire-board-12mm',
  'A1/B1 级防火基材，耐潮不燃。', 'A1/B1 fire substrate, moisture resistant.',
  'KZQ 玻镁防火板以氧化镁、氯化镁为主材，添加阻燃纤维增强，达到 B 级防火标准，遇火不燃，无有毒烟雾，适用于酒店、商场、医院等公共场所隔墙与吊顶。',
  'KZQ MGO fire board uses magnesium oxide and chloride with fire-resistant fiber, meets B-rated fire standard, non-combustible and low smoke.',
  '氧化镁、氯化镁、玻纤布', 'MgO, MgCl2, fiberglass mesh',
  '2440×1220×12mm', 'B级', 'E0级',
  '请联系销售获取报价', 'Contact for quotation', '100 张',
  '托盘打包，防潮膜', 'Pallet packed, moisture film',
  '全国配送 / 海外集装箱', 'Nationwide / overseas container',
  '酒店隔墙、商场吊顶、医院墙体', 'Hotel partitions, mall ceilings, hospital walls',
  '', 'https://images.unsplash.com/photo-1581094288338-2314dddb7e14?w=800',
  'https://images.unsplash.com/photo-1581094288338-2314dddb7e14?w=800',
  true, true, 5
),
(
  '33333333-3333-3333-3333-333333333306',
  '11111111-1111-1111-1111-111111111103',
  '22222222-2222-2222-2222-222222222206',
  'KZQ 防火饰面板 工程定制', 'KZQ Fire-Rated Decorative Panel Custom', 'kzq-fire-rated-decorative-panel-custom',
  '防火 + 装饰一体化，工程定制。', 'Fire + decorative integrated, custom engineering.',
  'KZQ 防火饰面板将防火基材与装饰饰面一体化，既满足 B 级防火要求，又具备装饰效果，可定制花色与尺寸，适用于地铁、机场、学校等大型公共工程。',
  'KZQ fire-rated decorative panel integrates fire substrate and decorative surface, B-rated fire, customizable color and size.',
  '防火基材 + 三聚氰胺/UV 饰面', 'Fire substrate + melamine/UV surface',
  '2440×1220×18mm（可定制）', 'B级', 'E0级',
  '请联系销售获取报价', 'Contact for quotation', '80 张',
  '托盘打包，工程配送', 'Pallet packed, project delivery',
  '工程专车 / 海外整柜', 'Project truck / overseas container',
  '地铁、机场、学校、商业综合体', 'Subway, airport, school, commercial complex',
  '', 'https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=800',
  'https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=800',
  true, true, 6
),
(
  '33333333-3333-3333-3333-333333333307',
  '11111111-1111-1111-1111-111111111101',
  '22222222-2222-2222-2222-222222222201',
  'KZQ 海外出口级多层板 17mm', 'KZQ Export-Grade Multi-Layer Board 17mm', 'kzq-export-grade-multi-layer-board-17mm',
  '海外出口规格，CARB P2 / E0 认证。', 'Export spec, CARB P2 / E0 certified.',
  'KZQ 海外出口级多层板专门针对海外客户规格生产，符合 CARB Phase 2 与 E0 标准，含水率与胶合强度满足国际海运要求，可定制尺寸与包装，支持 FOB / CIF 条款。',
  'KZQ export-grade multi-layer board is produced to overseas specs, CARB Phase 2 and E0 compliant, suitable for international shipping.',
  '出口级杨木/桉木单板', 'Export-grade poplar/eucalyptus veneer',
  '2440×1220×17mm（可定制）', 'B级', 'E0级',
  '请联系销售获取报价', 'Contact for quotation', '1×20GP 集装箱',
  '出口托盘 + 熏蒸', 'Export pallet + fumigation',
  'FOB 宁波 / CIF 可协商', 'FOB Ningbo / CIF negotiable',
  '海外家具制造、工程承包商', 'Overseas furniture manufacturers, contractors',
  '', 'https://images.unsplash.com/photo-1604147706283-d7119b5b822c?w=800',
  'https://images.unsplash.com/photo-1604147706283-d7119b5b822c?w=800',
  false, true, 7
),
(
  '33333333-3333-3333-3333-333333333308',
  '11111111-1111-1111-1111-111111111102',
  '22222222-2222-2222-2222-222222222203',
  'KZQ 素色三聚氰胺板 哑光系列', 'KZQ Solid Color Melamine Panel Matte', 'kzq-solid-color-melamine-matte',
  '素色哑光饰面，现代简约风格。', 'Solid matte surface, modern minimalist style.',
  'KZQ 素色三聚氰胺板哑光系列提供多种莫兰迪色系选择，表面哑光触感细腻，抗指纹易清洁，是现代极简风格家具与空间的热门选择。',
  'KZQ solid color melamine matte series offers Morandi palette with soft touch, anti-fingerprint and easy clean.',
  '三聚氰胺饰面纸 + 环保基材', 'Melamine paper + eco substrate',
  '2440×1220×18mm', 'B级', 'E0级',
  '请联系销售获取报价', 'Contact for quotation', '200 张',
  '托盘打包，护角保护', 'Pallet packed with corner protectors',
  '国内配送 / 海外出口', 'Domestic / overseas export',
  '现代风格家具、办公空间', 'Modern furniture, office space',
  '', 'https://images.unsplash.com/photo-1567016432779-094069958ea5?w=800',
  'https://images.unsplash.com/photo-1567016432779-094069958ea5?w=800',
  false, true, 8
);

-- ============================================================
-- 产品多图（每个产品 2 张）
-- ============================================================
insert into public.product_images (product_id, image_url, alt_cn, alt_en, sort_order) values
('33333333-3333-3333-3333-333333333301', 'https://images.unsplash.com/photo-1604147706283-d7119b5b822c?w=800', '多层实木板正面', 'Multi-layer board front', 1),
('33333333-3333-3333-3333-333333333301', 'https://images.unsplash.com/photo-1581094794329-c8112a89af12?w=800', '多层实木板侧边', 'Multi-layer board edge', 2),
('33333333-3333-3333-3333-333333333302', 'https://images.unsplash.com/photo-1581094794329-c8112a89af12?w=800', 'MDF 表面', 'MDF surface', 1),
('33333333-3333-3333-3333-333333333302', 'https://images.unsplash.com/photo-1604147706283-d7119b5b822c?w=800', 'MDF 切面', 'MDF cross-section', 2),
('33333333-3333-3333-3333-333333333303', 'https://images.unsplash.com/photo-1567016432779-094069958ea5?w=800', '木纹饰面板', 'Wood grain panel', 1),
('33333333-3333-3333-3333-333333333303', 'https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=800', '木纹细节', 'Wood grain detail', 2),
('33333333-3333-3333-3333-333333333304', 'https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=800', 'UV 高光面板', 'UV high-gloss panel', 1),
('33333333-3333-3333-3333-333333333304', 'https://images.unsplash.com/photo-1567016432779-094069958ea5?w=800', '高光细节', 'Gloss detail', 2),
('33333333-3333-3333-3333-333333333305', 'https://images.unsplash.com/photo-1581094288338-2314dddb7e14?w=800', '玻镁防火板', 'MGO fire board', 1),
('33333333-3333-3333-3333-333333333305', 'https://images.unsplash.com/photo-1604147706283-d7119b5b822c?w=800', '防火板结构', 'Fire board structure', 2),
('33333333-3333-3333-3333-333333333306', 'https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=800', '防火饰面板', 'Fire decorative panel', 1),
('33333333-3333-3333-3333-333333333306', 'https://images.unsplash.com/photo-1581094288338-2314dddb7e14?w=800', '饰面细节', 'Surface detail', 2),
('33333333-3333-3333-3333-333333333307', 'https://images.unsplash.com/photo-1604147706283-d7119b5b822c?w=800', '出口级多层板', 'Export board', 1),
('33333333-3333-3333-3333-333333333307', 'https://images.unsplash.com/photo-1567016432779-094069958ea5?w=800', '出口包装', 'Export packaging', 2),
('33333333-3333-3333-3333-333333333308', 'https://images.unsplash.com/photo-1567016432779-094069958ea5?w=800', '素色哑光板', 'Solid matte panel', 1),
('33333333-3333-3333-3333-333333333308', 'https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=800', '哑光细节', 'Matte detail', 2);

-- ============================================================
-- 证书（3 个，仅展示版图片 URL）
-- ============================================================
insert into public.certificates (id, name_cn, name_en, description_cn, description_en, image_url, applicable_scope_cn, applicable_scope_en, is_published, sort_order) values
('44444444-4444-4444-4444-444444444401',
 'E0 级环保检测报告', 'E0 Environmental Test Report',
 'KZQ 板材甲醛释放量经第三方检测达到 E0 级标准。', 'KZQ boards formaldehyde emission tested to E0 grade by third party.',
 'https://images.unsplash.com/photo-1568667256549-094345857637?w=800',
 '全系列板材产品', 'All board series',
 true, 1),
('44444444-4444-4444-4444-444444444402',
 'B 级防火检测报告', 'B-Rated Fire Test Report',
 'KZQ 防火系列板材通过 B 级燃烧性能检测。', 'KZQ fire-rated series passed B-rated combustion performance test.',
 'https://images.unsplash.com/photo-1581094288338-2314dddb7e14?w=800',
 '防火板系列', 'Fire-rated panel series',
 true, 2),
('44444444-4444-4444-4444-444444444403',
 'ISO 9001 质量管理体系认证', 'ISO 9001 Quality Management Certification',
 'KZQ 通过 ISO 9001 质量管理体系认证，保障稳定的产品质量。', 'KZQ is ISO 9001 certified for stable product quality.',
 'https://images.unsplash.com/photo-1450101499163-c8848c66ca85?w=800',
 '全公司质量管理体系', 'Company-wide quality system',
 true, 3);

-- ============================================================
-- 公司信息（单例）
-- ============================================================
insert into public.company_profile (
  id, title_cn, title_en, description_cn, description_en,
  advantages_cn, advantages_en,
  phone, email, whatsapp, address_cn, address_en,
  wechat_qr_url, logo_url
) values (
  '55555555-5555-5555-5555-555555555501',
  'KZQ · 专注工程级板材与防火饰面', 'KZQ · Engineering-Grade Boards & Fire Decorative Panels',
  'KZQ 是一家专注于工程级板材、装饰饰面板与防火板材的品牌供应商。我们服务国内工程精装项目与海外经销商采购，提供 B 级防火、E0 环保等级的高品质板材产品。产品涵盖多层实木板、MDF、三聚氰胺饰面板、UV 涂装板、玻镁防火板等，支持规格定制与海外出口。',
  'KZQ is a brand supplier specializing in engineering-grade boards, decorative panels and fire-rated panels. We serve domestic project finishing and overseas distributor procurement, offering B-rated fire and E0 eco grade boards. Products cover multi-layer solid boards, MDF, melamine panels, UV panels and MGO fire boards, with custom sizes and export support.',
  '[
    {"icon":"flame","title_cn":"B 级防火","title_en":"B-Rated Fire","desc_cn":"防火系列通过 B 级燃烧性能检测，适用于公共场所。","desc_en":"Fire series passed B-rated combustion test for public spaces."},
    {"icon":"leaf","title_cn":"E0 环保","title_en":"E0 Eco","desc_cn":"甲醛释放量≤0.05mg/m³，达到 E0 级标准。","desc_en":"Formaldehyde ≤0.05mg/m³, E0 grade standard."},
    {"icon":"truck","title_cn":"工程交付","title_en":"Project Delivery","desc_cn":"支持大型工程批量供货与定制规格生产。","desc_en":"Bulk supply for large projects and custom sizes."},
    {"icon":"globe","title_cn":"海外出口","title_en":"Overseas Export","desc_cn":"符合 CARB P2 / E0 标准，支持 FOB / CIF。","desc_en":"CARB P2 / E0 compliant, FOB / CIF supported."}
  ]'::jsonb,
  '[
    {"icon":"flame","title_cn":"B-Rated Fire","title_en":"B-Rated Fire","desc_cn":"Fire series passed B-rated combustion test.","desc_en":"Fire series passed B-rated combustion test for public spaces."},
    {"icon":"leaf","title_cn":"E0 Eco","title_en":"E0 Eco","desc_cn":"Formaldehyde ≤0.05mg/m³, E0 grade.","desc_en":"Formaldehyde ≤0.05mg/m³, E0 grade standard."},
    {"icon":"truck","title_cn":"Project Delivery","title_en":"Project Delivery","desc_cn":"Bulk supply for large projects.","desc_en":"Bulk supply for large projects and custom sizes."},
    {"icon":"globe","title_cn":"Overseas Export","title_en":"Overseas Export","desc_cn":"CARB P2 / E0 compliant, FOB / CIF.","desc_en":"CARB P2 / E0 compliant, FOB / CIF supported."}
  ]'::jsonb,
  '+86 138-0000-0000',
  'sales@kzq-example.com',
  '+86 138 0000 0000',
  '中国浙江省杭州市 XX 区 XX 路 XX 号',
  'No. XX Road, XX District, Hangzhou, Zhejiang, China',
  'https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=400',
  'https://images.unsplash.com/photo-1611162616475-46b635cb6898?w=200'
);

-- ============================================================
-- 站点设置（单例）
-- ============================================================
insert into public.site_settings (
  id, site_name, default_language,
  meta_title_cn, meta_title_en,
  meta_description_cn, meta_description_en
) values (
  '66666666-6666-6666-6666-666666666601',
  'KZQ Product Catalog',
  'zh',
  'KZQ | 工程级板材·防火饰面板·海外出口供应商',
  'KZQ | Engineering Boards, Fire Decorative Panels, Export Supplier',
  'KZQ 专注工程级板材、B 级防火、E0 环保饰面板，服务国内工程精装与海外采购，支持定制规格与 FOB/CIF 出口。',
  'KZQ specializes in engineering boards, B-rated fire and E0 eco panels for domestic projects and overseas procurement.'
);

-- ============================================================
-- 示例询盘（2 条，方便后台演示）
-- ============================================================
insert into public.inquiries (name, company, country, email, whatsapp, interested_product, quantity, message, status, source) values
('John Smith', 'Smith Furniture LLC', 'United States', 'john@smithfurniture.com', '+1 555 123 4567', 'KZQ Export-Grade Multi-Layer Board 17mm', '1×20GP container', 'We are looking for a stable supplier of multi-layer boards for our furniture factory. Please send catalog and FOB Ningbo price.', 'new', 'h5'),
(' Ahmed Hassan', 'Gulf Interiors', 'UAE', 'ahmed@gulfinteriors.ae', '+971 50 123 4567', 'KZQ Fire-Rated Decorative Panel Custom', '5000 sqm', 'Need fire-rated decorative panels for a hotel project in Dubai. B-rated fire certification required. Please contact us urgently.', 'new', 'h5');
