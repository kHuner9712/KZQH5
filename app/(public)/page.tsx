import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ProductCard } from "@/components/public/ProductCard";
import { FireBadge, EcoBadge } from "@/components/public/Badge";
import { EmptyState } from "@/components/public/EmptyState";
import {
  Flame,
  Leaf,
  Truck,
  Globe,
  ArrowRight,
  ChevronRight,
  Award,
  Phone,
} from "lucide-react";
import type { Product, Category, CompanyProfile } from "@/types/database";

export const revalidate = 60;

export default async function HomePage() {
  const supabase = createServerSupabaseClient();

  const [
    { data: featuredProducts },
    { data: categories },
    { data: company },
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
      .single(),
  ]);

  const advantages = (company as CompanyProfile | null)?.advantages_cn || [];
  const logoUrl = (company as CompanyProfile | null)?.logo_url;

  const advantageIcons: Record<string, typeof Flame> = {
    flame: Flame,
    leaf: Leaf,
    truck: Truck,
    globe: Globe,
  };

  return (
    <div className="animate-fade-in">
      {/* Hero 区 */}
      <section className="bg-hero-gradient relative overflow-hidden">
        <div className="bg-grid pointer-events-none absolute inset-0 opacity-40" />
        <div className="relative px-6 pb-10 pt-12 text-white">
          <div className="flex items-center gap-3">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="KZQ" className="h-12 w-12 rounded-lg object-cover" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-white/10 text-lg font-bold text-gradient-gold">
                KZQ
              </div>
            )}
            <div>
              <h1 className="text-2xl font-bold tracking-tight">KZQ</h1>
              <p className="text-xs text-gray-400">工程级板材 · 防火饰面 · 海外出口</p>
            </div>
          </div>
          <p className="mt-6 text-lg font-medium leading-relaxed">
            专注<span className="text-gradient-gold"> B 级防火 </span>
            与<span className="text-gradient-gold"> E0 环保</span>等级
            <br />
            工程板材与装饰饰面供应商
          </p>
          <p className="mt-3 text-sm leading-relaxed text-gray-400">
            服务国内工程精装项目与海外经销商采购，支持定制规格与 FOB / CIF 出口。
          </p>
          <div className="mt-6 flex gap-3">
            <Link
              href="/products"
              className="inline-flex items-center gap-1.5 rounded-lg bg-steel px-5 py-2.5 text-sm font-medium text-white transition hover:bg-steel-dark"
            >
              浏览产品 <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/contact"
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-white/10"
            >
              <Phone className="h-4 w-4" /> 立即询盘
            </Link>
          </div>
        </div>
      </section>

      {/* 核心优势 */}
      {advantages.length > 0 && (
        <section className="px-4 py-6">
          <div className="grid grid-cols-2 gap-3">
            {advantages.map((adv, i) => {
              const Icon = advantageIcons[adv.icon] || Flame;
              return (
                <div
                  key={i}
                  className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-gray-100"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-steel/10">
                    <Icon className="h-5 w-5 text-steel" />
                  </div>
                  <h3 className="mt-2.5 text-sm font-semibold text-graphite">
                    {adv.title_cn}
                  </h3>
                  <p className="mt-1 text-[11px] leading-relaxed text-gray-500">
                    {adv.desc_cn}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 一级类目入口 */}
      {categories && categories.length > 0 && (
        <section className="px-4 py-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-graphite">产品类目</h2>
            <Link href="/products" className="text-xs text-steel">
              全部 <ChevronRight className="inline h-3 w-3" />
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {(categories as Category[]).map((cat) => (
              <Link
                key={cat.id}
                href={`/products?category=${cat.slug}`}
                className="group relative overflow-hidden rounded-2xl bg-graphite p-4 text-white transition hover:bg-graphite-50"
              >
                <div className="bg-grid absolute inset-0 opacity-30" />
                <div className="relative">
                  <h3 className="text-sm font-semibold">{cat.name_cn}</h3>
                  {cat.name_en && (
                    <p className="mt-0.5 text-[10px] uppercase tracking-wider text-gray-400">
                      {cat.name_en}
                    </p>
                  )}
                  <p className="mt-2 line-clamp-2 text-[11px] text-gray-400">
                    {cat.description_cn}
                  </p>
                  <span className="mt-2 inline-flex items-center gap-0.5 text-[11px] text-gold">
                    查看 <ArrowRight className="h-3 w-3" />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* 主推产品 */}
      <section className="px-4 py-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-graphite">主推产品</h2>
          <Link href="/products" className="text-xs text-steel">
            全部 <ChevronRight className="inline h-3 w-3" />
          </Link>
        </div>
        {featuredProducts && featuredProducts.length > 0 ? (
          <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 no-scrollbar">
            {(featuredProducts as Product[]).map((p) => (
              <div key={p.id} className="w-[200px] shrink-0">
                <ProductCard product={p} />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="暂无主推产品" description="请在后台设置主推产品" />
        )}
      </section>

      {/* 卖点徽章区 */}
      <section className="px-4 py-6">
        <div className="rounded-2xl bg-graphite p-6 text-center text-white">
          <div className="bg-grid pointer-events-none absolute inset-0 rounded-2xl opacity-20" />
          <div className="relative">
            <h2 className="text-base font-semibold">品质承诺</h2>
            <p className="mt-1 text-xs text-gray-400">第三方检测认证 · 工程级标准</p>
            <div className="mt-4 flex justify-center gap-3">
              <div className="rounded-xl bg-white/5 px-4 py-3 ring-1 ring-white/10">
                <FireBadge />
                <p className="mt-1.5 text-[10px] text-gray-400">燃烧性能检测</p>
              </div>
              <div className="rounded-xl bg-white/5 px-4 py-3 ring-1 ring-white/10">
                <EcoBadge />
                <p className="mt-1.5 text-[10px] text-gray-400">甲醛释放量</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 证书入口 */}
      <section className="px-4 pb-6">
        <Link
          href="/certificates"
          className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-sm ring-1 ring-gray-100"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gold/15">
              <Award className="h-5 w-5 text-gold-dark" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-graphite">资质证书</h3>
              <p className="text-[11px] text-gray-500">环保 / 防火 / 体系认证</p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-gray-400" />
        </Link>
      </section>

      {/* 询盘 CTA */}
      <section className="px-4 pb-8">
        <Link
          href="/contact"
          className="block rounded-2xl bg-gradient-to-r from-steel to-steel-dark p-5 text-white shadow-lg"
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold">获取专属报价</h3>
              <p className="mt-0.5 text-xs text-blue-100">
                国内工程 · 海外采购 · 规格定制
              </p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20">
              <ArrowRight className="h-5 w-5" />
            </div>
          </div>
        </Link>
      </section>
    </div>
  );
}
