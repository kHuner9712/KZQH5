import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ProductCard } from "@/components/public/ProductCard";
import { EmptyState } from "@/components/public/EmptyState";
import { SearchBox } from "@/components/public/SearchBox";
import { cn } from "@/lib/utils";
import { PackageOpen } from "lucide-react";
import type { Product, Category, Subcategory } from "@/types/database";

export const revalidate = 60;

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: { category?: string; subcategory?: string; q?: string };
}) {
  const supabase = createServerSupabaseClient();

  const { data: categories } = await supabase
    .from("categories")
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  // 当前选中的一级类目
  const activeCategorySlug = searchParams.category;
  const activeCategory = (categories as Category[] | null)?.find(
    (c) => c.slug === activeCategorySlug
  );

  // 二级类目（若选中一级类目则筛选）
  let subcategoriesQuery = supabase
    .from("subcategories")
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (activeCategory) {
    subcategoriesQuery = subcategoriesQuery.eq("category_id", activeCategory.id);
  }
  const { data: subcategories } = await subcategoriesQuery;

  // 产品查询
  let productsQuery = supabase
    .from("products")
    .select("*")
    .eq("is_published", true)
    .order("is_featured", { ascending: false })
    .order("sort_order", { ascending: true });

  if (activeCategory) {
    productsQuery = productsQuery.eq("category_id", activeCategory.id);
  }
  if (searchParams.subcategory) {
    const sub = (subcategories as Subcategory[] | null)?.find(
      (s) => s.slug === searchParams.subcategory
    );
    if (sub) {
      productsQuery = productsQuery.eq("subcategory_id", sub.id);
    }
  }
  if (searchParams.q) {
    productsQuery = productsQuery.or(
      `name_cn.ilike.%${searchParams.q}%,name_en.ilike.%${searchParams.q}%,summary_cn.ilike.%${searchParams.q}%`
    );
  }

  const { data: products } = await productsQuery;

  function buildUrl(params: Record<string, string | undefined>) {
    const sp = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v) sp.set(k, v);
    });
    const str = sp.toString();
    return str ? `/products?${str}` : "/products";
  }

  return (
    <div className="animate-fade-in">
      {/* 顶部标题 */}
      <div className="bg-graphite px-4 pb-4 pt-8 text-white">
        <h1 className="text-xl font-bold">产品中心</h1>
        <p className="mt-1 text-xs text-gray-400">
          工程级板材 · 防火饰面 · 海外出口
        </p>
      </div>

      {/* 搜索 + 筛选 sticky */}
      <div className="sticky top-0 z-30 border-b border-gray-100 bg-white/95 px-4 py-3 backdrop-blur-lg">
        <SearchBox />

        {/* 一级类目 chips */}
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
          <Link
            href="/products"
            className={cn(
              "shrink-0 rounded-full px-3.5 py-1.5 text-xs font-medium transition",
              !activeCategorySlug
                ? "bg-steel text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            )}
          >
            全部
          </Link>
          {(categories as Category[] | null)?.map((cat) => (
            <Link
              key={cat.id}
              href={buildUrl({ category: cat.slug })}
              className={cn(
                "shrink-0 rounded-full px-3.5 py-1.5 text-xs font-medium transition",
                activeCategorySlug === cat.slug
                  ? "bg-steel text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              )}
            >
              {cat.name_cn}
            </Link>
          ))}
        </div>

        {/* 二级类目 chips */}
        {subcategories && subcategories.length > 0 && (
          <div className="mt-2 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
            <Link
              href={buildUrl({ category: activeCategorySlug })}
              className={cn(
                "shrink-0 rounded-full px-3 py-1 text-[11px] transition",
                !searchParams.subcategory
                  ? "bg-graphite text-white"
                  : "bg-gray-50 text-gray-500 hover:bg-gray-100"
              )}
            >
              全部
            </Link>
            {(subcategories as Subcategory[]).map((sub) => (
              <Link
                key={sub.id}
                href={buildUrl({
                  category: activeCategorySlug,
                  subcategory: sub.slug,
                })}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1 text-[11px] transition",
                  searchParams.subcategory === sub.slug
                    ? "bg-graphite text-white"
                    : "bg-gray-50 text-gray-500 hover:bg-gray-100"
                )}
              >
                {sub.name_cn}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* 产品列表 */}
      <div className="px-4 py-4">
        {products && products.length > 0 ? (
          <>
            <p className="mb-3 text-xs text-gray-400">
              共 {products.length} 个产品
            </p>
            <div className="grid grid-cols-2 gap-3">
              {(products as Product[]).map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          </>
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
      </div>
    </div>
  );
}
