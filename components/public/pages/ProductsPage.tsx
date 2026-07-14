import Link from "next/link";
import { ChevronLeft, ChevronRight, PackageOpen } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EmptyState } from "@/components/public/EmptyState";
import { ProductCard } from "@/components/public/ProductCard";
import { ResponsiveContainer } from "@/components/public/ResponsiveContainer";
import { SearchBox } from "@/components/public/SearchBox";
import { isDemoMode } from "@/lib/demo";
import { localizeCategory, localizePage, localizeSubcategory } from "@/lib/i18n/content";
import { localePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";
import { getMockCategoryBySlug, getMockSubcategories, mockCategories } from "@/lib/mock-data";
import { fetchPageContent } from "@/lib/queries/cms";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import { cn } from "@/lib/utils";
import type { Category, Product, Subcategory } from "@/types/database";
import { searchProducts } from "@/lib/services/products/search";
import { ContextEventTracker } from "@/components/public/AnalyticsTracker";

export const publicProductsRevalidate = 300;
const PAGE_SIZE = 24;
export interface ProductSearchParams { category?: string; subcategory?: string; q?: string; page?: string }
const pageNumber = (raw?: string) => Math.max(1, Number.isFinite(Number(raw)) ? Math.floor(Number(raw)) : 1);

export async function getProductsMetadata(locale: Locale): Promise<Metadata> { const content = localizePage(await fetchPageContent("products"), locale); const copy = getDictionary(locale).products; return buildLocalizedMetadata({ locale, path: "/products", title: content.seoTitle || content.title || copy.title, description: content.seoDescription || content.description || copy.description }); }
export function generateMetadata() { return getProductsMetadata("zh"); }

export async function ProductsPageContent(locale: Locale, searchParams: ProductSearchParams) {
  let categories: Category[] = []; let subcategories: Subcategory[] = []; let products: Product[] = []; let total = 0;
  const requestedPage = pageNumber(searchParams.page);
  if (isDemoMode()) {
    categories = [...mockCategories].sort((a, b) => a.sort_order - b.sort_order);
    const active = getMockCategoryBySlug(searchParams.category); subcategories = getMockSubcategories(active?.id);
  } else {
    const supabase = createPublicSupabaseClient();
    const { data: categoryData, error: categoryError } = await supabase.from("categories").select("*").eq("is_active", true).order("sort_order", { ascending: true }); if (categoryError) throw new Error("PUBLIC_DATA_UNAVAILABLE", { cause: categoryError }); categories = (categoryData as Category[] | null) || [];
    const active = categories.find((item) => item.slug === searchParams.category);
    let subQuery = supabase.from("subcategories").select("*").eq("is_active", true).order("sort_order", { ascending: true }); if (active) subQuery = subQuery.eq("category_id", active.id); const { data: subData, error: subError } = await subQuery; if (subError) throw new Error("PUBLIC_DATA_UNAVAILABLE", { cause: subError }); subcategories = (subData as Subcategory[] | null) || [];
  }
  const active = categories.find((item) => item.slug === searchParams.category);
  const selectedSubcategory = subcategories.find((item) => item.slug === searchParams.subcategory);
  const searchResult = await searchProducts({
    query: searchParams.q,
    categoryId: active?.id,
    subcategoryId: selectedSubcategory?.id,
    page: requestedPage,
    pageSize: PAGE_SIZE,
  });
  products = searchResult.items;
  total = searchResult.total;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const buildUrl = (changes: Partial<ProductSearchParams>) => { const merged = { ...searchParams, ...changes }; const params = new URLSearchParams(); Object.entries(merged).forEach(([key, value]) => { if (value && !(key === "page" && value === "1")) params.set(key, value); }); const query = params.toString(); return `${localePath(locale, "/products")}${query ? `?${query}` : ""}`; };
  if (total > 0 && requestedPage > totalPages) redirect(buildUrl({ page: String(totalPages) }));
  const content = localizePage(await fetchPageContent("products"), locale); const copy = getDictionary(locale); const activeCategory = categories.find((item) => item.slug === searchParams.category);
  return (
    <div className="animate-fade-in bg-canvas">
      {searchParams.q && <ContextEventTracker eventName="product_search" locale={locale} />}
      {searchParams.category && <ContextEventTracker eventName="category_click" locale={locale} />}
      <div className="bg-canvas-warm texture-paper"><ResponsiveContainer className="pb-4 pt-9 md:pb-6 md:pt-14"><p className="text-[10px] uppercase tracking-[0.2em] text-brass md:text-xs">Products</p><h1 className="mt-1.5 text-xl font-bold tracking-tight text-ink md:text-3xl">{content.title || copy.products.title}</h1><p className="mt-1 text-[12px] text-ink-soft md:text-sm">{content.subtitle || copy.products.subtitle}</p>{content.description && <p className="mt-2 max-w-2xl text-[11.5px] leading-relaxed text-ink-mute">{content.description}</p>}</ResponsiveContainer></div>
      <div className="sticky top-0 z-30 border-b border-ink-line bg-white/95 backdrop-blur-lg md:top-16"><ResponsiveContainer className="py-3"><SearchBox locale={locale} /><div className="mt-3 flex gap-2 overflow-x-auto pb-1 no-scrollbar"><Link href={buildUrl({ category: undefined, subcategory: undefined, page: undefined })} className={cn("shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-medium", !searchParams.category ? "bg-industrial text-white" : "bg-canvas-warm text-ink-soft")}>{copy.common.all}</Link>{categories.map((category) => <Link key={category.id} href={buildUrl({ category: category.slug, subcategory: undefined, page: undefined })} className={cn("shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-medium", searchParams.category === category.slug ? "bg-industrial text-white" : "bg-canvas-warm text-ink-soft")}>{localizeCategory(category, locale).name}</Link>)}</div>{subcategories.length > 0 && <div className="mt-2 flex gap-2 overflow-x-auto pb-1 no-scrollbar"><Link href={buildUrl({ subcategory: undefined, page: undefined })} className={cn("shrink-0 rounded-full px-3 py-1 text-[11px]", !searchParams.subcategory ? "bg-ink text-white" : "bg-canvas-cool text-ink-mute")}>{copy.common.all}</Link>{subcategories.map((subcategory) => <Link key={subcategory.id} href={buildUrl({ subcategory: subcategory.slug, page: undefined })} className={cn("shrink-0 rounded-full px-3 py-1 text-[11px]", searchParams.subcategory === subcategory.slug ? "bg-ink text-white" : "bg-canvas-cool text-ink-mute")}>{localizeSubcategory(subcategory, locale).name}</Link>)}</div>}</ResponsiveContainer></div>
      <ResponsiveContainer className="pt-4"><div className="flex items-center justify-between text-[11px] text-ink-mute"><div><Link href={localePath(locale)}>{copy.common.home}</Link><ChevronRight className="mx-1 inline h-3 w-3" />{copy.products.title}{activeCategory && <> <ChevronRight className="mx-1 inline h-3 w-3" />{localizeCategory(activeCategory, locale).name}</>}</div>{total > 0 && <span>{copy.common.total} <strong className="text-ink">{total}</strong></span>}</div></ResponsiveContainer>
      <ResponsiveContainer className="py-4 md:py-8">{products.length ? <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 md:gap-4 lg:grid-cols-4">{products.map((product) => <ProductCard key={product.id} product={product} locale={locale} />)}</div> : <EmptyState title={copy.products.empty} description={searchParams.q ? `${copy.products.noSearch}: ${searchParams.q}` : copy.products.emptyCategory} icon={PackageOpen} />}</ResponsiveContainer>
      {totalPages > 1 && <ResponsiveContainer className="pb-8"><nav className="flex items-center justify-center gap-3" aria-label={copy.products.pagination}><Link href={buildUrl({ page: String(Math.max(1, requestedPage - 1)) })} aria-disabled={requestedPage <= 1} tabIndex={requestedPage <= 1 ? -1 : undefined} className={cn("btn-outline h-10 px-4", requestedPage <= 1 && "pointer-events-none opacity-40")}><ChevronLeft className="h-4 w-4" />{copy.common.previous}</Link><span className="text-sm text-ink-soft">{requestedPage} / {totalPages}</span><Link href={buildUrl({ page: String(Math.min(totalPages, requestedPage + 1)) })} aria-disabled={requestedPage >= totalPages} tabIndex={requestedPage >= totalPages ? -1 : undefined} className={cn("btn-outline h-10 px-4", requestedPage >= totalPages && "pointer-events-none opacity-40")}>{copy.common.next}<ChevronRight className="h-4 w-4" /></Link></nav></ResponsiveContainer>}
    </div>
  );
}
export default function ProductsPage({ searchParams }: { searchParams: ProductSearchParams }) { return ProductsPageContent("zh", searchParams); }
