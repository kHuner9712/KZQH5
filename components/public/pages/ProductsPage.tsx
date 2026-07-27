import Link from "next/link";
import { ChevronLeft, ChevronRight, PackageOpen } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EmptyState } from "@/components/public/EmptyState";
import { ProductCard } from "@/components/public/ProductCard";
import { ResponsiveContainer } from "@/components/public/ResponsiveContainer";
import { PublicPageHero } from "@/components/public/PublicPageHero";
import { SearchBox } from "@/components/public/SearchBox";
import { isDemoMode } from "@/lib/demo";
import {
  localizeCategory,
  localizePage,
  localizeSubcategory,
} from "@/lib/i18n/content";
import { localePath, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { buildLocalizedMetadata } from "@/lib/i18n/metadata";
import {
  getMockCategoryBySlug,
  getMockSubcategories,
  mockCategories,
} from "@/lib/mock-data";
import { fetchPageContent } from "@/lib/queries/cms";
import { createPublicSupabaseClient } from "@/lib/supabase/public";
import { cn } from "@/lib/utils";
import { PublicDataUnavailableError } from "@/lib/repositories/public-types";
import { CATEGORY_FIELDS, SUBCATEGORY_FIELDS } from "@/lib/repositories/public-fields";
import type { Category, Product, Subcategory } from "@/types/database";
import { searchProducts } from "@/lib/services/products/search";
import { ContextEventTracker } from "@/components/public/AnalyticsTracker";

export const publicProductsRevalidate = 300;
const PAGE_SIZE = 24;
export interface ProductSearchParams {
  category?: string;
  subcategory?: string;
  q?: string;
  page?: string;
}
const pageNumber = (raw?: string) =>
  Math.max(1, Number.isFinite(Number(raw)) ? Math.floor(Number(raw)) : 1);

export async function getProductsMetadata(locale: Locale): Promise<Metadata> {
  const content = localizePage(await fetchPageContent("products"), locale);
  const copy = getDictionary(locale).products;
  return buildLocalizedMetadata({
    locale,
    path: "/products",
    title: content.seoTitle || content.title || copy.title,
    description:
      content.seoDescription || content.description || copy.description,
  });
}
export function generateMetadata() {
  return getProductsMetadata("zh");
}

export async function ProductsPageContent(
  locale: Locale,
  searchParams: ProductSearchParams,
) {
  let categories: Category[] = [];
  let subcategories: Subcategory[] = [];
  let products: Product[] = [];
  let total = 0;
  const requestedPage = pageNumber(searchParams.page);
  if (isDemoMode()) {
    categories = [...mockCategories].sort(
      (a, b) => a.sort_order - b.sort_order,
    );
    const active = getMockCategoryBySlug(searchParams.category);
    subcategories = getMockSubcategories(active?.id);
  } else {
    const supabase = createPublicSupabaseClient();
    const { data: categoryData, error: categoryError } = await supabase
      .from("categories")
      .select(CATEGORY_FIELDS)
      .eq("is_active", true)
      .order("sort_order", { ascending: true });
    if (categoryError)
      throw new PublicDataUnavailableError("PUBLIC_DATA_READ_FAILED", { cause: categoryError });
    categories = (categoryData as unknown as Category[] | null) || [];
    const active = categories.find(
      (item) => item.slug === searchParams.category,
    );
    let subQuery = supabase
      .from("subcategories")
      .select(SUBCATEGORY_FIELDS)
      .eq("is_active", true)
      .order("sort_order", { ascending: true });
    if (active) subQuery = subQuery.eq("category_id", active.id);
    const { data: subData, error: subError } = await subQuery;
    if (subError)
      throw new PublicDataUnavailableError("PUBLIC_DATA_READ_FAILED", { cause: subError });
    subcategories = (subData as unknown as Subcategory[] | null) || [];
  }
  const active = categories.find((item) => item.slug === searchParams.category);
  const selectedSubcategory = subcategories.find(
    (item) => item.slug === searchParams.subcategory,
  );
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
  const buildUrl = (changes: Partial<ProductSearchParams>) => {
    const merged = { ...searchParams, ...changes };
    const params = new URLSearchParams();
    Object.entries(merged).forEach(([key, value]) => {
      if (value && !(key === "page" && value === "1")) params.set(key, value);
    });
    const query = params.toString();
    return `${localePath(locale, "/products")}${query ? `?${query}` : ""}`;
  };
  if (total > 0 && requestedPage > totalPages)
    redirect(buildUrl({ page: String(totalPages) }));
  const content = localizePage(await fetchPageContent("products"), locale);
  const copy = getDictionary(locale);
  const activeCategory = categories.find(
    (item) => item.slug === searchParams.category,
  );
  return (
    <div className="animate-fade-in bg-canvas">
      {searchParams.q && (
        <ContextEventTracker eventName="product_search" locale={locale} />
      )}
      {searchParams.category && (
        <ContextEventTracker eventName="category_click" locale={locale} />
      )}
      <PublicPageHero
        eyebrow="Products"
        title={content.title || copy.products.title}
        subtitle={content.subtitle || copy.products.subtitle}
        description={content.description}
      />
      <div className="border-b border-ink-line bg-white/95 backdrop-blur-lg lg:sticky lg:top-16 lg:z-30">
        <ResponsiveContainer className="py-3">
          <SearchBox locale={locale} />
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
            <Link
              href={buildUrl({
                category: undefined,
                subcategory: undefined,
                page: undefined,
              })}
              prefetch={false}
              className={cn(
                "inline-flex min-h-11 shrink-0 items-center rounded-md border px-3.5 py-2 text-xs font-medium",
                !searchParams.category
                  ? "border-gold/40 bg-page text-gold-light"
                  : "border-ink-line bg-canvas-warm text-ink-soft",
              )}
            >
              {copy.common.all}
            </Link>
            {categories.map((category) => (
              <Link
                key={category.id}
                href={buildUrl({
                  category: category.slug,
                  subcategory: undefined,
                  page: undefined,
                })}
                prefetch={false}
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center rounded-md border px-3.5 py-2 text-xs font-medium",
                  searchParams.category === category.slug
                    ? "border-gold/40 bg-page text-gold-light"
                    : "border-ink-line bg-canvas-warm text-ink-soft",
                )}
              >
                {localizeCategory(category, locale).name}
              </Link>
            ))}
          </div>
          {subcategories.length > 0 && (
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
              <Link
                href={buildUrl({ subcategory: undefined, page: undefined })}
                prefetch={false}
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center rounded-md border px-3 text-[11px]",
                  !searchParams.subcategory
                    ? "border-page bg-page text-white"
                    : "border-ink-line bg-canvas-cool text-ink-mute",
                )}
              >
                {copy.common.all}
              </Link>
              {subcategories.map((subcategory) => (
                <Link
                  key={subcategory.id}
                  href={buildUrl({
                    subcategory: subcategory.slug,
                    page: undefined,
                  })}
                  prefetch={false}
                  className={cn(
                    "inline-flex min-h-11 shrink-0 items-center rounded-md border px-3 text-[11px]",
                    searchParams.subcategory === subcategory.slug
                      ? "border-page bg-page text-white"
                      : "border-ink-line bg-canvas-cool text-ink-mute",
                  )}
                >
                  {localizeSubcategory(subcategory, locale).name}
                </Link>
              ))}
            </div>
          )}
        </ResponsiveContainer>
      </div>
      <ResponsiveContainer className="pt-4">
        <div className="hidden items-center justify-between text-[11px] text-ink-mute sm:flex">
          <div>
            <Link href={localePath(locale)} prefetch={false}>{copy.common.home}</Link>
            <ChevronRight className="mx-1 inline h-3 w-3" />
            {copy.products.title}
            {activeCategory && (
              <>
                {" "}
                <ChevronRight className="mx-1 inline h-3 w-3" />
                {localizeCategory(activeCategory, locale).name}
              </>
            )}
          </div>
          {total > 0 && (
            <span>
              {copy.common.total} <strong className="text-ink">{total}</strong>
            </span>
          )}
        </div>
      </ResponsiveContainer>
      <ResponsiveContainer className="py-6 md:py-12">
        {products.length ? (
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 md:gap-5 lg:grid-cols-4">
            {products.map((product) => (
              <ProductCard key={product.id} product={product} locale={locale} />
            ))}
          </div>
        ) : (
          <EmptyState
            title={copy.products.empty}
            description={
              searchParams.q
                ? `${copy.products.noSearch}: ${searchParams.q}`
                : copy.products.emptyCategory
            }
            icon={PackageOpen}
          />
        )}
      </ResponsiveContainer>
      {totalPages > 1 && (
        <ResponsiveContainer className="pb-8">
          <nav
            className="flex items-center justify-center gap-3"
            aria-label={copy.products.pagination}
          >
            <Link
              href={buildUrl({ page: String(Math.max(1, requestedPage - 1)) })}
              aria-disabled={requestedPage <= 1}
              tabIndex={requestedPage <= 1 ? -1 : undefined}
              prefetch={false}
              className={cn(
                "btn-outline h-10 px-4",
                requestedPage <= 1 && "pointer-events-none opacity-40",
              )}
            >
              <ChevronLeft className="h-4 w-4" />
              {copy.common.previous}
            </Link>
            <span className="text-sm text-ink-soft">
              {requestedPage} / {totalPages}
            </span>
            <Link
              href={buildUrl({
                page: String(Math.min(totalPages, requestedPage + 1)),
              })}
              aria-disabled={requestedPage >= totalPages}
              tabIndex={requestedPage >= totalPages ? -1 : undefined}
              prefetch={false}
              className={cn(
                "btn-outline h-10 px-4",
                requestedPage >= totalPages && "pointer-events-none opacity-40",
              )}
            >
              {copy.common.next}
              <ChevronRight className="h-4 w-4" />
            </Link>
          </nav>
        </ResponsiveContainer>
      )}
    </div>
  );
}
export default function ProductsPage({
  searchParams,
}: {
  searchParams: ProductSearchParams;
}) {
  return ProductsPageContent("zh", searchParams);
}
