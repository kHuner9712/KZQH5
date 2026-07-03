import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import {
  mockCategories,
  mockProducts,
  getMockCategoryBySlug,
  getMockSubcategories,
} from "@/lib/mock-data";
import { fetchPageContent } from "@/lib/queries/cms";
import { ProductCard } from "@/components/public/ProductCard";
import { EmptyState } from "@/components/public/EmptyState";
import { SearchBox } from "@/components/public/SearchBox";
import { ResponsiveContainer } from "@/components/public/ResponsiveContainer";
import { cn } from "@/lib/utils";
import { PackageOpen, ChevronRight, ChevronLeft, ChevronsLeft, ChevronsRight } from "lucide-react";
import type { Metadata } from "next";
import type { Product, Category, Subcategory } from "@/types/database";

export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  const page = await fetchPageContent("products");
  return {
    title: page?.seo_title_cn ?? "产品中心",
    description:
      page?.seo_description_cn ??
      "KZQ 工程级板材产品中心：防火板、饰面板、工程基材等多品类，支持规格定制与海外出口。",
  };
}

// 默认每页数量
const DEFAULT_PAGE_SIZE = 24;
const ALLOWED_PAGE_SIZES = [12, 24, 48];

function parsePage(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function parsePageSize(raw: string | undefined): number {
  const n = Number(raw);
  if (!ALLOWED_PAGE_SIZES.includes(n)) return DEFAULT_PAGE_SIZE;
  return n;
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: {
    category?: string;
    subcategory?: string;
    q?: string;
    page?: string;
    pageSize?: string;
  };
}) {
  let categories: Category[] = [];
  let subcategories: Subcategory[] = [];
  let products: Product[] = [];
  let total = 0;

  // 分页参数
  const page = parsePage(searchParams.page);
  const pageSize = parsePageSize(searchParams.pageSize);

  if (isDemoMode()) {
    categories = [...mockCategories].sort((a, b) => a.sort_order - b.sort_order);
    const activeCat = getMockCategoryBySlug(searchParams.category);
    subcategories = getMockSubcategories(activeCat?.id);

    let filtered = [...mockProducts].filter((p) => p.is_published);
    if (activeCat) {
      filtered = filtered.filter((p) => p.category_id === activeCat.id);
    }
    if (searchParams.subcategory) {
      const sub = subcategories.find((s) => s.slug === searchParams.subcategory);
      if (sub) {
        filtered = filtered.filter((p) => p.subcategory_id === sub.id);
      }
    }
    if (searchParams.q) {
      const q = searchParams.q.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.name_cn.toLowerCase().includes(q) ||
          (p.name_en || "").toLowerCase().includes(q) ||
          (p.summary_cn || "").toLowerCase().includes(q)
      );
    }
    filtered.sort((a, b) => {
      if (a.is_featured !== b.is_featured) return a.is_featured ? -1 : 1;
      return a.sort_order - b.sort_order;
    });

    // Demo 模式模拟分页
    total = filtered.length;
    const from = (page - 1) * pageSize;
    const to = from + pageSize;
    products = filtered.slice(from, to);
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

    // 主查询 + count 查询，复用相同筛选条件
    let productsQuery = supabase
      .from("products")
      .select("*", { count: "exact" })
      .eq("is_published", true)
      .order("is_featured", { ascending: false })
      .order("sort_order", { ascending: true });

    let countQuery = supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("is_published", true);

    if (activeCat) {
      productsQuery = productsQuery.eq("category_id", activeCat.id);
      countQuery = countQuery.eq("category_id", activeCat.id);
    }
    if (searchParams.subcategory) {
      const sub = subcategories.find((s) => s.slug === searchParams.subcategory);
      if (sub) {
        productsQuery = productsQuery.eq("subcategory_id", sub.id);
        countQuery = countQuery.eq("subcategory_id", sub.id);
      }
    }
    if (searchParams.q) {
      const orExpr = `name_cn.ilike.%${searchParams.q}%,name_en.ilike.%${searchParams.q}%,summary_cn.ilike.%${searchParams.q}%`;
      productsQuery = productsQuery.or(orExpr);
      countQuery = countQuery.or(orExpr);
    }

    // range 分页
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    productsQuery = productsQuery.range(from, to);

    const [listRes, countRes] = await Promise.all([productsQuery, countQuery]);
    products = (listRes.data as Product[] | null) || [];
    total = countRes.count || 0;
  }

  const activeCategorySlug = searchParams.category;
  const activeCategory = categories.find((c) => c.slug === activeCategorySlug);

  // CMS 页面内容（Demo 模式自动回退到 mock 数据）
  const cmsPage = await fetchPageContent("products");

  // 分页计算
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);

  // 构建带筛选参数 + page 的 URL（保留 category/subcategory/q/pageSize）
  function buildUrl(
    params: Partial<{
      category: string | undefined;
      subcategory: string | undefined;
      q: string | undefined;
      page: number | undefined;
      pageSize: number | undefined;
    }>
  ) {
    const sp = new URLSearchParams();
    const merged = {
      category: searchParams.category,
      subcategory: searchParams.subcategory,
      q: searchParams.q,
      pageSize: pageSize !== DEFAULT_PAGE_SIZE ? String(pageSize) : undefined,
      ...params,
    };
    Object.entries(merged).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
    });
    const str = sp.toString();
    return str ? `/products?${str}` : "/products";
  }

  // 分页按钮：首页 / 上一页 / 下一页 / 末页
  const hasPrev = currentPage > 1;
  const hasNext = currentPage < totalPages;

  return (
    <div className="animate-fade-in bg-canvas">
      {/* 顶部标题区 */}
      <div className="bg-canvas-warm texture-paper">
        <ResponsiveContainer className="pb-4 pt-9 md:pb-6 md:pt-14">
          <p className="text-[10px] uppercase tracking-[0.2em] text-brass md:text-xs">
            Products
          </p>
          <h1 className="mt-1.5 text-xl font-bold tracking-tight text-ink md:mt-2 md:text-3xl">
            {cmsPage?.title_cn ?? "产品中心"}
          </h1>
          <p className="mt-1 text-[12px] text-ink-soft md:mt-2 md:text-sm">
            {cmsPage?.subtitle_cn ?? "工程级板材 · 防火饰面 · 海外出口"}
          </p>
          {cmsPage?.description_cn && (
            <p className="mt-2 max-w-2xl text-[11.5px] leading-relaxed text-ink-mute md:text-xs md:leading-relaxed">
              {cmsPage.description_cn}
            </p>
          )}
        </ResponsiveContainer>
      </div>

      {/* 搜索 + 筛选 sticky（mobile top-0, desktop top-16 避开 header） */}
      <div className="sticky top-0 z-30 border-b border-ink-line bg-white/95 backdrop-blur-lg md:top-16">
        <ResponsiveContainer className="py-3">
          <SearchBox />

          {/* 一级类目 chips */}
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
            <Link
              href={buildUrl({ category: undefined, subcategory: undefined, page: 1 })}
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
                href={buildUrl({ category: cat.slug, subcategory: undefined, page: 1 })}
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
                href={buildUrl({ category: activeCategorySlug, subcategory: undefined, page: 1 })}
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
                    page: 1,
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

      {/* 面包屑 + 产品数（真实 total） */}
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
          {total > 0 && (
            <span className="text-[11px] text-ink-mute md:text-xs">
              共 <span className="font-semibold text-ink">{total}</span> 个
              {totalPages > 1 && (
                <>
                  {" · 第 "}
                  <span className="font-semibold text-ink">{currentPage}</span>
                  /{totalPages} 页
                </>
              )}
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

      {/* 分页控件 */}
      {totalPages > 1 && (
        <ResponsiveContainer className="pb-8 md:pb-12">
          <nav
            className="flex items-center justify-center gap-1.5 md:gap-2"
            aria-label="产品分页"
          >
            <Link
              href={buildUrl({ page: 1 })}
              aria-label="首页"
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-lg border border-ink-line text-ink-soft transition md:h-10 md:w-10",
                hasPrev ? "hover:border-industrial hover:text-industrial" : "pointer-events-none opacity-40"
              )}
            >
              <ChevronsLeft className="h-4 w-4" />
            </Link>
            <Link
              href={buildUrl({ page: Math.max(1, currentPage - 1) })}
              aria-label="上一页"
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-lg border border-ink-line text-ink-soft transition md:h-10 md:w-10",
                hasPrev ? "hover:border-industrial hover:text-industrial" : "pointer-events-none opacity-40"
              )}
            >
              <ChevronLeft className="h-4 w-4" />
            </Link>

            {/* 页码（最多显示 5 个） */}
            {(() => {
              const pages: number[] = [];
              let start = Math.max(1, currentPage - 2);
              const end = Math.min(totalPages, start + 4);
              start = Math.max(1, end - 4);
              for (let i = start; i <= end; i++) pages.push(i);
              return pages.map((p) => (
                <Link
                  key={p}
                  href={buildUrl({ page: p })}
                  aria-label={`第 ${p} 页`}
                  className={cn(
                    "flex h-9 min-w-[2.25rem] items-center justify-center rounded-lg border px-2 text-[12px] font-medium transition md:h-10 md:min-w-[2.5rem] md:text-[13px]",
                    p === currentPage
                      ? "border-industrial bg-industrial text-white"
                      : "border-ink-line text-ink-soft hover:border-industrial hover:text-industrial"
                  )}
                >
                  {p}
                </Link>
              ));
            })()}

            <Link
              href={buildUrl({ page: Math.min(totalPages, currentPage + 1) })}
              aria-label="下一页"
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-lg border border-ink-line text-ink-soft transition md:h-10 md:w-10",
                hasNext ? "hover:border-industrial hover:text-industrial" : "pointer-events-none opacity-40"
              )}
            >
              <ChevronRight className="h-4 w-4" />
            </Link>
            <Link
              href={buildUrl({ page: totalPages })}
              aria-label="末页"
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-lg border border-ink-line text-ink-soft transition md:h-10 md:w-10",
                hasNext ? "hover:border-industrial hover:text-industrial" : "pointer-events-none opacity-40"
              )}
            >
              <ChevronsRight className="h-4 w-4" />
            </Link>
          </nav>
        </ResponsiveContainer>
      )}
    </div>
  );
}
