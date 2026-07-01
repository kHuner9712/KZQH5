import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import {
  mockCategories,
  mockProducts,
  getMockCategoryBySlug,
  getMockSubcategories,
} from "@/lib/mock-data";
import { ProductCard } from "@/components/public/ProductCard";
import { EmptyState } from "@/components/public/EmptyState";
import { SearchBox } from "@/components/public/SearchBox";
import { ResponsiveContainer } from "@/components/public/ResponsiveContainer";
import { cn } from "@/lib/utils";
import { PackageOpen, ChevronRight } from "lucide-react";
import type { Product, Category, Subcategory } from "@/types/database";

export const revalidate = 60;

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: { category?: string; subcategory?: string; q?: string };
}) {
  let categories: Category[] = [];
  let subcategories: Subcategory[] = [];
  let products: Product[] = [];

  if (isDemoMode()) {
    categories = [...mockCategories].sort((a, b) => a.sort_order - b.sort_order);
    const activeCat = getMockCategoryBySlug(searchParams.category);
    subcategories = getMockSubcategories(activeCat?.id);

    products = [...mockProducts].filter((p) => p.is_published);
    if (activeCat) {
      products = products.filter((p) => p.category_id === activeCat.id);
    }
    if (searchParams.subcategory) {
      const sub = subcategories.find((s) => s.slug === searchParams.subcategory);
      if (sub) {
        products = products.filter((p) => p.subcategory_id === sub.id);
      }
    }
    if (searchParams.q) {
      const q = searchParams.q.toLowerCase();
      products = products.filter(
        (p) =>
          p.name_cn.toLowerCase().includes(q) ||
          (p.name_en || "").toLowerCase().includes(q) ||
          (p.summary_cn || "").toLowerCase().includes(q)
      );
    }
    products.sort((a, b) => {
      if (a.is_featured !== b.is_featured) return a.is_featured ? -1 : 1;
      return a.sort_order - b.sort_order;
    });
  } else {
    const supabase = createServerSupabaseClient();

    const { data: categoriesData } = await supabase
      .from("categories")
      .select("*")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });
    categories = (categoriesData as Category[] | null) || [];

    const activeCat = categories.find((c) => c.slug === searchParams.category);

    let subcategoriesQuery = supabase
      .from("subcategories")
      .select("*")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });
    if (activeCat) {
      subcategoriesQuery = subcategoriesQuery.eq("category_id", activeCat.id);
    }
    const { data: subcategoriesData } = await subcategoriesQuery;
    subcategories = (subcategoriesData as Subcategory[] | null) || [];

    let productsQuery = supabase
      .from("products")
      .select("*")
      .eq("is_published", true)
      .order("is_featured", { ascending: false })
      .order("sort_order", { ascending: true });

    if (activeCat) {
      productsQuery = productsQuery.eq("category_id", activeCat.id);
    }
    if (searchParams.subcategory) {
      const sub = subcategories.find((s) => s.slug === searchParams.subcategory);
      if (sub) {
        productsQuery = productsQuery.eq("subcategory_id", sub.id);
      }
    }
    if (searchParams.q) {
      productsQuery = productsQuery.or(
        `name_cn.ilike.%${searchParams.q}%,name_en.ilike.%${searchParams.q}%,summary_cn.ilike.%${searchParams.q}%`
      );
    }
    const { data: productsData } = await productsQuery;
    products = (productsData as Product[] | null) || [];
  }

  const activeCategorySlug = searchParams.category;
  const activeCategory = categories.find((c) => c.slug === activeCategorySlug);

  function buildUrl(params: Record<string, string | undefined>) {
    const sp = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v) sp.set(k, v);
    });
    const str = sp.toString();
    return str ? `/products?${str}` : "/products";
  }

  return (
    <div className="animate-fade-in bg-canvas">
      {/* 顶部标题区 */}
      <div className="bg-canvas-warm texture-paper">
        <ResponsiveContainer className="pb-4 pt-9 md:pb-6 md:pt-14">
          <p className="text-[10px] uppercase tracking-[0.2em] text-brass md:text-xs">
            Products
          </p>
          <h1 className="mt-1.5 text-xl font-bold tracking-tight text-ink md:mt-2 md:text-3xl">
            产品中心
          </h1>
          <p className="mt-1 text-[12px] text-ink-soft md:mt-2 md:text-sm">
            工程级板材 · 防火饰面 · 海外出口
          </p>
        </ResponsiveContainer>
      </div>

      {/* 搜索 + 筛选 sticky（mobile top-0, desktop top-16 避开 header） */}
      <div className="sticky top-0 z-30 border-b border-ink-line bg-white/95 backdrop-blur-lg md:top-16">
        <ResponsiveContainer className="py-3">
          <SearchBox />

          {/* 一级类目 chips */}
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
            <Link
              href="/products"
              className={cn(
                "shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition md:text-[13px]",
                !activeCategorySlug
                  ? "bg-industrial text-white"
                  : "bg-canvas-warm text-ink-soft hover:bg-canvas-cool"
              )}
            >
              全部
            </Link>
            {categories.map((cat) => (
              <Link
                key={cat.id}
                href={buildUrl({ category: cat.slug })}
                className={cn(
                  "shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition md:text-[13px]",
                  activeCategorySlug === cat.slug
                    ? "bg-industrial text-white"
                    : "bg-canvas-warm text-ink-soft hover:bg-canvas-cool"
                )}
              >
                {cat.name_cn}
              </Link>
            ))}
          </div>

          {/* 二级类目 chips */}
          {subcategories.length > 0 && (
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
              <Link
                href={buildUrl({ category: activeCategorySlug })}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1 text-[11px] transition md:text-xs",
                  !searchParams.subcategory
                    ? "bg-ink text-white"
                    : "bg-canvas-cool text-ink-mute hover:bg-canvas-warm"
                )}
              >
                全部
              </Link>
              {subcategories.map((sub) => (
                <Link
                  key={sub.id}
                  href={buildUrl({
                    category: activeCategorySlug,
                    subcategory: sub.slug,
                  })}
                  className={cn(
                    "shrink-0 rounded-full px-3 py-1 text-[11px] transition md:text-xs",
                    searchParams.subcategory === sub.slug
                      ? "bg-ink text-white"
                      : "bg-canvas-cool text-ink-mute hover:bg-canvas-warm"
                  )}
                >
                  {sub.name_cn}
                </Link>
              ))}
            </div>
          )}
        </ResponsiveContainer>
      </div>

      {/* 面包屑 + 产品数 */}
      <ResponsiveContainer className="pt-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 text-[11px] text-ink-mute md:text-xs">
            <Link href="/" className="hover:text-industrial">首页</Link>
            <ChevronRight className="h-3 w-3" />
            <span className="text-ink-soft">产品中心</span>
            {activeCategory && (
              <>
                <ChevronRight className="h-3 w-3" />
                <span className="text-ink-soft">{activeCategory.name_cn}</span>
              </>
            )}
          </div>
          {products.length > 0 && (
            <span className="text-[11px] text-ink-mute md:text-xs">
              共 <span className="font-semibold text-ink">{products.length}</span> 个
            </span>
          )}
        </div>
      </ResponsiveContainer>

      {/* 产品列表：mobile 2 / tablet 3 / desktop 4 */}
      <ResponsiveContainer className="py-4 md:py-8">
        {products.length > 0 ? (
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 md:gap-4 lg:grid-cols-4">
            {products.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="暂无产品"
            description={
              searchParams.q
                ? `未找到与「${searchParams.q}」相关的产品`
                : "该分类下暂无已发布产品"
            }
            icon={PackageOpen}
          />
        )}
      </ResponsiveContainer>
    </div>
  );
}
