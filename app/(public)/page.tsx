import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import { mockCompany, mockCategories, getMockFeaturedProducts } from "@/lib/mock-data";
import { BrandLogo } from "@/components/public/BrandLogo";
import { FeatureCard } from "@/components/public/FeatureCard";
import { CategoryCard } from "@/components/public/CategoryCard";
import { ProductCard } from "@/components/public/ProductCard";
import { SectionHeader } from "@/components/public/SectionHeader";
import { ArrowRight, Flame, Leaf, Truck, Globe2, ChevronRight } from "lucide-react";
import type { Product, Category, CompanyProfile } from "@/types/database";

export const revalidate = 60;

export default async function HomePage() {
  let featuredProducts: Product[] = [];
  let categories: Category[] = [];
  let company: CompanyProfile | null = null;

  if (isDemoMode()) {
    featuredProducts = getMockFeaturedProducts(6);
    categories = [...mockCategories].sort((a, b) => a.sort_order - b.sort_order);
    company = mockCompany;
  } else {
    const supabase = createServerSupabaseClient();
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
        .limit(6),
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

  return (
    <div className="animate-fade-in bg-canvas">
      {/* ========== Hero ========== */}
      <section className="relative overflow-hidden bg-canvas-warm px-5 pb-8 pt-10 texture-paper">
        {/* 顶部品牌行 */}
        <div className="relative flex items-center justify-between">
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
        <div className="relative mt-9">
          <p className="text-[10px] uppercase tracking-[0.22em] text-brass">
            Engineering Boards · Fire-Rated Decorative Panels
          </p>
          <h1 className="mt-2.5 text-[26px] font-bold leading-[1.25] tracking-tight text-ink">
            专注 B 级防火
            <br />
            <span className="text-industrial-gradient">E0 环保</span> 工程板材
          </h1>
          <p className="mt-3 max-w-[19rem] text-[12.5px] leading-relaxed text-ink-soft">
            KZQ 是工程级板材与装饰饰面板品牌供应商，服务国内工程精装与海外采购，欢迎通过询盘表单联系合作。
          </p>

          {/* CTA */}
          <div className="mt-5 flex gap-2.5">
            <Link
              href="/products"
              className="btn-primary h-11 flex-1 text-[13px]"
            >
              浏览产品
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/contact"
              className="btn-outline h-11 flex-1 text-[13px]"
            >
              立即询盘
            </Link>
          </div>
        </div>
      </section>

      {/* ========== 核心优势 2x2 ========== */}
      <section className="px-5 pt-7">
        <SectionHeader
          title="核心优势"
          subtitle="为什么选择 KZQ 工程级板材"
        />
        <div className="mt-3 grid grid-cols-2 gap-2.5">
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
        </div>
      </section>

      {/* ========== 产品类目 ========== */}
      {categories.length > 0 && (
        <section className="px-5 pt-8">
          <SectionHeader
            title="产品类目"
            subtitle="按应用场景选择合适的板材"
            action={
              <Link
                href="/products"
                className="inline-flex items-center gap-0.5 text-[11px] text-industrial"
              >
                全部 <ChevronRight className="h-3 w-3" />
              </Link>
            }
          />
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            {categories.map((cat) => (
              <CategoryCard key={cat.id} category={cat} className="min-h-[130px]" />
            ))}
          </div>
        </section>
      )}

      {/* ========== 主推产品 ========== */}
      {featuredProducts.length > 0 && (
        <section className="px-5 pt-8">
          <SectionHeader
            title="主推产品"
            subtitle="B 级防火 · E0 环保 · 工程批量供货"
            action={
              <Link
                href="/products"
                className="inline-flex items-center gap-0.5 text-[11px] text-industrial"
              >
                全部 <ChevronRight className="h-3 w-3" />
              </Link>
            }
          />
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            {featuredProducts.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </section>
      )}

      {/* ========== 询盘 CTA ========== */}
      <section className="px-5 pt-8 pb-4">
        <Link
          href="/contact"
          className="card-base relative block overflow-hidden bg-industrial p-5 text-white"
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
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/60">
                Get Quotation
              </p>
              <h3 className="mt-1 text-base font-semibold">
                联系 KZQ 获取报价
              </h3>
              <p className="mt-0.5 text-[11px] text-white/70">
                国内工程 · 海外采购 · 规格定制
              </p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 backdrop-blur-sm">
              <ArrowRight className="h-5 w-5" />
            </div>
          </div>
        </Link>
      </section>
    </div>
  );
}
