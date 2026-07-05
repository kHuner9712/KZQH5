import Link from "next/link";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import { isDemoMode } from "@/lib/demo";
import { mockCompany, mockCategories, getMockFeaturedProducts } from "@/lib/mock-data";
import { fetchHomepageContent } from "@/lib/queries/cms";
import { BrandLogo } from "@/components/public/BrandLogo";
import { FeatureCard } from "@/components/public/FeatureCard";
import { CategoryCard } from "@/components/public/CategoryCard";
import { ProductCard } from "@/components/public/ProductCard";
import { SectionHeader } from "@/components/public/SectionHeader";
import { ResponsiveContainer } from "@/components/public/ResponsiveContainer";
import { ProductImage } from "@/components/public/ProductImage";
import { ArrowRight, Flame, Leaf, Truck, Globe2, ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Product, Category, CompanyProfile, HomeFeatureItem } from "@/types/database";

export const revalidate = 300;

export default async function HomePage() {
  let featuredProducts: Product[] = [];
  let categories: Category[] = [];
  let company: CompanyProfile | null = null;

  if (isDemoMode()) {
    featuredProducts = getMockFeaturedProducts(8);
    categories = [...mockCategories].sort((a, b) => a.sort_order - b.sort_order);
    company = mockCompany;
  } else {
    const supabase = createPublicSupabaseClient();
    const [
      { data: featuredData },
      { data: categoriesData },
      { data: companyData },
    ] = await Promise.all([
      supabase
        .from("products")
        .select("*")
        .eq("is_published", true)
        .eq("is_featured", true)
        .order("sort_order", { ascending: true })
        .limit(8),
      supabase
        .from("categories")
        .select("*")
        .eq("is_active", true)
        .order("sort_order", { ascending: true }),
      supabase
        .from("company_profile")
        .select("*")
        .limit(1)
        .maybeSingle(),
    ]);
    featuredProducts = (featuredData as Product[] | null) || [];
    categories = (categoriesData as Category[] | null) || [];
    company = (companyData as CompanyProfile | null) || null;
  }

  // CMS 首页内容（Demo 模式自动回退到 mock 数据）
  const home = await fetchHomepageContent();

  // 核心优势图标映射
  const featureIconMap: Record<string, LucideIcon> = {
    flame: Flame,
    leaf: Leaf,
    truck: Truck,
    globe: Globe2,
  };
  const dynamicFeatures: HomeFeatureItem[] =
    home?.features_cn && home.features_cn.length > 0 ? home.features_cn : [];

  // Hero 右侧预览产品（取前 3 个主推产品做预览卡）
  const heroPreviewProducts = featuredProducts.slice(0, 3);

  return (
    <div className="animate-fade-in bg-canvas">
      {/* ========== Hero ========== */}
      <section className="relative overflow-hidden bg-canvas-warm texture-paper">
        {/* mobile 单列 / desktop 左右分栏 */}
        <div className="container-responsive py-10 md:py-20">
          <div className="grid items-center gap-8 md:grid-cols-2 md:gap-12 lg:gap-16">
            {/* 左侧：品牌与 CTA */}
            <div>
              {/* mobile 顶部品牌行（desktop 隐藏，由 DesktopHeader 显示） */}
              <div className="flex items-center justify-between md:hidden">
                <div className="flex items-center gap-2.5">
                  <BrandLogo logoUrl={company?.logo_url} size={36} />
                  <div className="leading-tight">
                    <p className="text-[15px] font-bold tracking-tight text-ink">KZQ</p>
                    <p className="text-[9px] uppercase tracking-[0.18em] text-ink-mute">
                      Engineering Boards
                    </p>
                  </div>
                </div>
                <Link
                  href="/about"
                  className="rounded-full border border-ink-line bg-white px-3 py-1 text-[11px] text-ink-soft transition hover:border-industrial/30 hover:text-industrial"
                >
                  关于我们
                </Link>
              </div>

              {/* 主标题区 */}
              <div className="mt-6 md:mt-0">
                <p className="text-[10px] uppercase tracking-[0.22em] text-brass md:text-xs">
                  {home?.hero_eyebrow_cn ?? "Engineering Boards · Fire-Rated Decorative Panels"}
                </p>
                <h1 className="mt-2.5 text-[26px] font-bold leading-[1.25] tracking-tight text-ink md:text-4xl lg:text-5xl md:leading-[1.2]">
                  {home?.hero_title_cn ?? "专注 B 级防火"}
                  <br />
                  <span className="text-industrial-gradient">{home?.hero_highlight_cn ?? "E0 环保 工程板材"}</span>
                </h1>
                <p className="mt-3 max-w-md text-[12.5px] leading-relaxed text-ink-soft md:mt-5 md:text-base md:leading-relaxed">
                  {home?.hero_description_cn ??
                    "KZQ 是工程级板材与装饰饰面板品牌供应商，服务国内工程精装与海外采购，覆盖防火板、饰面板、工程基材等多品类，支持规格定制与 FOB/CIF 出口。"}
                </p>

                {/* CTA */}
                <div className="mt-5 flex gap-2.5 md:mt-8 md:gap-3">
                  <Link
                    href="/products"
                    className="btn-primary h-11 flex-1 text-[13px] md:h-12 md:flex-none md:px-7 md:text-sm"
                  >
                    {home?.primary_cta_text_cn ?? "浏览产品"}
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    href="/contact"
                    className="btn-outline h-11 flex-1 text-[13px] md:h-12 md:flex-none md:px-7 md:text-sm"
                  >
                    {home?.secondary_cta_text_cn ?? "立即询盘"}
                  </Link>
                </div>

                {/* 关键数据条（desktop） */}
                <div className="mt-8 hidden grid-cols-3 gap-6 border-t border-ink-line/60 pt-6 md:grid">
                  <div>
                    <p className="text-2xl font-bold text-ink">B 级</p>
                    <p className="mt-0.5 text-[11px] text-ink-mute">防火等级</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-ink">E0</p>
                    <p className="mt-0.5 text-[11px] text-ink-mute">环保等级</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-ink">FOB/CIF</p>
                    <p className="mt-0.5 text-[11px] text-ink-mute">出口条款</p>
                  </div>
                </div>
              </div>
            </div>

            {/* 右侧：产品视觉预览卡（desktop） */}
            <div className="hidden md:block">
              <div className="relative">
                {/* 主预览大卡 */}
                <div className="card-base overflow-hidden">
                  <div className="aspect-[4/3] w-full">
                    <ProductImage
                      src={heroPreviewProducts[0]?.cover_image_url}
                      alt={heroPreviewProducts[0]?.name_cn || "KZQ 工程板材"}
                      placeholder="product"
                      loading="eager"
                    />
                  </div>
                  <div className="flex items-center justify-between p-4">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-brass">Featured</p>
                      <p className="mt-0.5 text-sm font-semibold text-ink">
                        {heroPreviewProducts[0]?.name_cn || "KZQ 主推板材"}
                      </p>
                      <p className="mt-0.5 text-[11px] text-ink-mute">
                        {heroPreviewProducts[0]?.name_en || "Engineering Board"}
                      </p>
                    </div>
                    <Link
                      href={`/products/${heroPreviewProducts[0]?.slug || ""}`}
                      className="flex h-9 w-9 items-center justify-center rounded-full bg-industrial-50 text-industrial transition hover:bg-industrial hover:text-white"
                    >
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  </div>
                </div>

                {/* 副预览卡（错落） */}
                {heroPreviewProducts[1] && (
                  <div className="card-base absolute -bottom-6 -left-6 hidden w-44 overflow-hidden lg:block">
                    <div className="aspect-square w-full">
                      <ProductImage
                        src={heroPreviewProducts[1]?.cover_image_url}
                        alt={heroPreviewProducts[1]?.name_cn || "KZQ 板材"}
                        placeholder="product"
                        loading="lazy"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ========== 核心优势 ========== */}
      <section className="container-responsive py-8 md:py-16">
        <SectionHeader
          title={home?.feature_section_title_cn ?? "核心优势"}
          subtitle={home?.feature_section_subtitle_cn ?? "为什么选择 KZQ 工程级板材"}
          size="large"
        />
        {/* mobile 2x2 / desktop 4 列横排 */}
        <div className="mt-4 grid grid-cols-2 gap-2.5 md:mt-6 md:grid-cols-4 md:gap-4">
          {dynamicFeatures.length > 0
            ? dynamicFeatures.map((item, i) => {
                const Icon = featureIconMap[item.icon] || Flame;
                return (
                  <FeatureCard
                    key={i}
                    icon={Icon}
                    title={item.title}
                    desc={item.description}
                  />
                );
              })
            : (
              <>
                <FeatureCard
                  icon={Flame}
                  title="B 级防火"
                  desc="第三方燃烧性能检测，达到 B 级防火标准"
                />
                <FeatureCard
                  icon={Leaf}
                  title="E0 环保"
                  desc="甲醛释放量达到 E0 级，适用于室内精装"
                />
                <FeatureCard
                  icon={Truck}
                  title="工程交付"
                  desc="稳定产能保障工程批量供货，规格可定制"
                />
                <FeatureCard
                  icon={Globe2}
                  title="海外出口"
                  desc="支持集装箱 FOB/CIF 出口，多语言询盘响应"
                />
              </>
            )}
        </div>
      </section>

      {/* ========== 产品类目 ========== */}
      {categories.length > 0 && (
        <section className="container-responsive py-8 md:py-12">
          <SectionHeader
            title={home?.category_section_title_cn ?? "产品类目"}
            subtitle={home?.category_section_subtitle_cn ?? "按应用场景选择合适的板材"}
            size="large"
            action={
              <Link
                href="/products"
                className="inline-flex items-center gap-0.5 text-[11px] text-industrial md:text-sm"
              >
                全部 <ChevronRight className="h-3 w-3 md:h-4 md:w-4" />
              </Link>
            }
          />
          {/* mobile 2 列 / desktop 3 列 */}
          <div className="mt-4 grid grid-cols-2 gap-2.5 md:mt-6 md:grid-cols-3 md:gap-4">
            {categories.map((cat) => (
              <CategoryCard key={cat.id} category={cat} className="min-h-[130px] md:min-h-[160px]" />
            ))}
          </div>
        </section>
      )}

      {/* ========== 主推产品 ========== */}
      {featuredProducts.length > 0 && (
        <section className="container-responsive py-8 md:py-12">
          <SectionHeader
            title={home?.featured_products_title_cn ?? "主推产品"}
            subtitle={home?.featured_products_subtitle_cn ?? "B 级防火 · E0 环保 · 工程批量供货"}
            size="large"
            action={
              <Link
                href="/products"
                className="inline-flex items-center gap-0.5 text-[11px] text-industrial md:text-sm"
              >
                全部 <ChevronRight className="h-3 w-3 md:h-4 md:w-4" />
              </Link>
            }
          />
          {/* mobile 2 列 / tablet 3 列 / desktop 4 列 */}
          <div className="mt-4 grid grid-cols-2 gap-2.5 md:mt-6 md:grid-cols-3 md:gap-4 lg:grid-cols-4">
            {featuredProducts.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </section>
      )}

      {/* ========== 询盘 CTA ========== */}
      <section className="container-responsive py-8 pb-4 md:py-16">
        <Link
          href="/contact"
          className="card-base relative block overflow-hidden bg-industrial p-5 text-white md:p-10"
        >
          <div
            className="absolute inset-0 opacity-[0.08]"
            style={{
              backgroundImage:
                "repeating-linear-gradient(90deg, rgba(255,255,255,0.6) 0, rgba(255,255,255,0.6) 1px, transparent 1px, transparent 28px)",
            }}
          />
          <div className="relative flex items-center justify-between">
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/60 md:text-xs">
                Get Quotation
              </p>
              <h3 className="mt-1 text-base font-semibold md:mt-2 md:text-2xl">
                {home?.bottom_cta_title_cn ?? "联系 KZQ 获取报价"}
              </h3>
              <p className="mt-0.5 text-[11px] text-white/70 md:mt-1 md:text-sm">
                {home?.bottom_cta_description_cn ?? "国内工程 · 海外采购 · 规格定制"}
              </p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 backdrop-blur-sm md:h-14 md:w-14">
              <ArrowRight className="h-5 w-5 md:h-6 md:w-6" />
            </div>
          </div>
        </Link>
      </section>
    </div>
  );
}
