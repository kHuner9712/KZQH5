import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import {
  mockCategories,
  mockSubcategories,
  mockCertificates,
  mockCompany,
  getMockProductBySlug,
  getMockProductImages,
} from "@/lib/mock-data";
import { ImageCarousel } from "@/components/public/ImageCarousel";
import { FireBadge, EcoBadge } from "@/components/public/Badge";
import { ProductImage } from "@/components/public/ProductImage";
import { ResponsiveContainer } from "@/components/public/ResponsiveContainer";
import {
  Ruler,
  Layers,
  Package,
  Truck,
  Boxes,
  CheckCircle2,
  ArrowLeft,
  Phone,
  Award,
  ChevronRight,
  ArrowRight,
} from "lucide-react";
import type {
  Product,
  ProductImage as ProductImageType,
  Category,
  Subcategory,
  Certificate,
} from "@/types/database";

export const revalidate = 60;

// 动态 metadata
export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  let product:
    | Pick<
        Product,
        | "name_cn"
        | "name_en"
        | "summary_cn"
        | "summary_en"
        | "cover_image_url"
        | "seo_title_cn"
        | "seo_description_cn"
      >
    | null
    | undefined = null;

  if (isDemoMode()) {
    product = getMockProductBySlug(params.slug) || null;
  } else {
    const supabase = createServerSupabaseClient();
    const { data } = await supabase
      .from("products")
      .select(
        "name_cn, name_en, summary_cn, summary_en, cover_image_url, seo_title_cn, seo_description_cn"
      )
      .eq("slug", params.slug)
      .eq("is_published", true)
      .single();
    product = data as typeof product | null;
  }

  if (!product) {
    return { title: "产品未找到" };
  }

  const title = product.seo_title_cn ?? `${product.name_cn} | KZQ`;
  const description = product.seo_description_cn ?? product.summary_cn ?? product.name_cn;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: product.cover_image_url ? [{ url: product.cover_image_url }] : [],
      type: "website",
    },
  };
}

export default async function ProductDetailPage({
  params,
}: {
  params: { slug: string };
}) {
  let product: Product | null = null;
  let images: ProductImageType[] = [];
  let category: Category | null = null;
  let subcategory: Subcategory | null = null;
  let certificates: Certificate[] = [];
  let companyPhone: string | null = null;

  if (isDemoMode()) {
    product = getMockProductBySlug(params.slug);
    if (product) {
      images = getMockProductImages(product.id);
      category = mockCategories.find((c) => c.id === product!.category_id) || null;
      subcategory =
        mockSubcategories.find((s) => s.id === product!.subcategory_id) || null;
      certificates = [...mockCertificates].sort(
        (a, b) => a.sort_order - b.sort_order
      );
      companyPhone = mockCompany.phone;
    }
  } else {
    const supabase = createServerSupabaseClient();

    const { data: productData } = await supabase
      .from("products")
      .select("*")
      .eq("slug", params.slug)
      .eq("is_published", true)
      .single();

    product = (productData as Product | null) || null;

    if (product) {
      const [
        { data: imagesData },
        { data: categoryData },
        { data: subcategoryData },
        { data: certificatesData },
        { data: companyData },
      ] = await Promise.all([
        supabase
          .from("product_images")
          .select("*")
          .eq("product_id", product.id)
          .order("sort_order", { ascending: true }),
        product.category_id
          ? supabase
              .from("categories")
              .select("*")
              .eq("id", product.category_id)
              .single()
          : Promise.resolve({ data: null }),
        product.subcategory_id
          ? supabase
              .from("subcategories")
              .select("*")
              .eq("id", product.subcategory_id)
              .single()
          : Promise.resolve({ data: null }),
        supabase
          .from("certificates")
          .select("*")
          .eq("is_published", true)
          .order("sort_order", { ascending: true })
          .limit(4),
        supabase
          .from("company_profile")
          .select("phone")
          .limit(1)
          .maybeSingle(),
      ]);

      images = (imagesData as ProductImageType[] | null) || [];
      category = (categoryData as Category | null) || null;
      subcategory = (subcategoryData as Subcategory | null) || null;
      certificates = (certificatesData as Certificate[] | null) || [];
      companyPhone = (companyData as { phone: string | null } | null)?.phone || null;
    }
  }

  if (!product) {
    notFound();
  }

  const p = product as Product;

  const carouselImages = [
    ...(p.cover_image_url
      ? [{ url: p.cover_image_url, alt: p.name_cn }]
      : []),
    ...images
      .filter((img) => img.image_url)
      .map((img) => ({
        url: img.image_url as string,
        alt: img.alt_cn || p.name_cn,
      })),
  ];

  const cat = category as Category | null;
  const sub = subcategory as Subcategory | null;
  const certs = certificates;

  // 规格表
  const specs: Array<{ icon: typeof Ruler; label: string; value?: string | null }> = [
    { icon: Ruler, label: "规格尺寸", value: p.size },
    { icon: Layers, label: "材质", value: p.material_cn },
    { icon: Package, label: "包装说明", value: p.packaging_cn },
    { icon: Truck, label: "物流说明", value: p.logistics_cn },
    { icon: Boxes, label: "最小起订量", value: p.moq },
    { icon: CheckCircle2, label: "应用场景", value: p.application_cn },
  ];

  // JSON-LD Product
  // KZQ 产品价格为 "Contact for quotation"，没有公开数值价格。
  // 为避免误导搜索引擎（price: "0" 会被解读为免费，非数字字符串为无效 price），
  // 仅当能从 price_display_cn 中解析出有效数值时才输出 price 字段，
  // 否则只标记可询盘与库存状态。
  function extractNumericPrice(raw: string | null | undefined): number | null {
    if (!raw) return null;
    // 排除明显的"询盘/联系"类描述
    if (/联系|询盘|quotation|contact|报价|面议|negotiat/i.test(raw)) return null;
    // 提取首个数字（支持小数与千分位）
    const match = raw.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
    if (!match) return null;
    const num = Number(match[0]);
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  const numericPrice = extractNumericPrice(p.price_display_cn);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name_cn,
    description: p.summary_cn || p.description_cn || p.name_cn,
    image: p.cover_image_url ? [p.cover_image_url] : undefined,
    sku: p.slug,
    brand: { "@type": "Brand", name: "KZQ" },
    category: cat?.name_cn,
    offers: {
      "@type": "Offer",
      availability: "https://schema.org/InStock",
      // 仅在解析出有效数值价格时输出 price；否则不输出 price 字段，避免无效 JSON-LD
      ...(numericPrice !== null
        ? {
            priceCurrency: "CNY",
            price: String(numericPrice),
          }
        : {}),
    },
  };

  // FAQ JSON-LD（仅在产品存在 FAQ 时输出）
  const faqJsonLd =
    p.faq_cn && p.faq_cn.length > 0
      ? {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: p.faq_cn.map((f) => ({
            "@type": "Question",
            name: f.question,
            acceptedAnswer: {
              "@type": "Answer",
              text: f.answer,
            },
          })),
        }
      : null;

  return (
    <div className="animate-fade-in bg-canvas pb-24 md:pb-0">
      {/* 顶部返回 sticky（mobile top-0, desktop top-16） */}
      <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-ink-line bg-white/95 backdrop-blur-lg md:top-16">
        <ResponsiveContainer className="py-3">
          <div className="flex items-center gap-3">
            <Link
              href="/products"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-canvas-warm text-ink-soft transition hover:bg-canvas-cool"
              aria-label="返回"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <span className="line-clamp-1 text-[13px] font-medium text-ink md:text-sm">
              {p.name_cn}
            </span>
          </div>
        </ResponsiveContainer>
      </div>

      {/* 主体：mobile 单列 / desktop 左右分栏 */}
      <ResponsiveContainer className="py-6 md:py-10">
        <div className="md:grid md:grid-cols-2 md:gap-10 lg:gap-14">
          {/* 左侧：图片轮播（desktop sticky） */}
          <div className="md:sticky md:top-24 md:self-start">
            <ImageCarousel images={carouselImages} videoUrl={p.video_url} />
          </div>

          {/* 右侧：产品信息 */}
          <div className="mt-5 md:mt-0">
            {/* 标题与卖点 */}
            <div className="flex flex-wrap gap-1.5">
              <FireBadge rating={p.fire_rating || "B级"} />
              <EcoBadge grade={p.eco_grade || "E0级"} />
              {p.is_featured && (
                <span className="chip chip-feature">主推产品</span>
              )}
            </div>
            <h1 className="mt-2 text-lg font-bold leading-snug text-ink md:mt-3 md:text-2xl md:leading-snug">
              {p.name_cn}
            </h1>
            {p.name_en && (
              <p className="mt-0.5 text-[11px] text-ink-mute md:text-xs">
                {p.name_en}
              </p>
            )}
            {p.summary_cn && (
              <p className="mt-2 text-[13px] leading-relaxed text-ink-soft md:mt-3 md:text-sm md:leading-relaxed">
                {p.summary_cn}
              </p>
            )}

            {/* 类目面包屑 */}
            {(cat || sub) && (
              <div className="mt-3 flex flex-wrap items-center gap-1 text-[11px] text-ink-mute md:text-xs">
                <Link href="/products" className="hover:text-industrial">产品中心</Link>
                {cat && (
                  <>
                    <ChevronRight className="h-3 w-3" />
                    <Link
                      href={`/products?category=${cat.slug}`}
                      className="hover:text-industrial"
                    >
                      {cat.name_cn}
                    </Link>
                  </>
                )}
                {sub && (
                  <>
                    <ChevronRight className="h-3 w-3" />
                    <span className="text-ink-soft">{sub.name_cn}</span>
                  </>
                )}
              </div>
            )}

            {/* 价格信息卡 */}
            <div className="mt-4 rounded-xl border border-ink-line bg-canvas-warm p-3.5 md:mt-5 md:p-5">
              <p className="text-[11px] text-ink-mute md:text-xs">公开价格</p>
              <p className="mt-0.5 text-[15px] font-semibold text-industrial md:text-lg">
                {p.price_display_cn || "请联系销售获取报价"}
              </p>
              {p.price_display_en && (
                <p className="text-[11px] text-ink-mute md:text-xs">{p.price_display_en}</p>
              )}
            </div>

            {/* desktop CTA：右侧固定询盘按钮 */}
            <div className="mt-4 hidden flex-col gap-2 md:mt-5 md:flex">
              <Link href="/contact" className="btn-primary h-12 w-full text-sm">
                立即询盘 · Get Quotation
                <ArrowRight className="h-4 w-4" />
              </Link>
              {companyPhone && (
                <a
                  href={`tel:${companyPhone.replace(/[^+\d]/g, "")}`}
                  className="btn-outline h-12 w-full text-sm"
                >
                  <Phone className="h-4 w-4" />
                  {companyPhone}
                </a>
              )}
            </div>

            {/* 产品描述 */}
            {p.description_cn && (
              <div className="mt-5 border-t border-ink-line pt-5">
                <h2 className="flex items-center text-sm font-semibold text-ink md:text-base">
                  <span className="mr-2 inline-block h-4 w-1 rounded-full bg-industrial" />
                  产品介绍
                </h2>
                <p className="mt-2 whitespace-pre-line text-[13px] leading-relaxed text-ink-soft md:mt-3 md:text-sm md:leading-relaxed">
                  {p.description_cn}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* GEO 摘要 - 产品概览 */}
        {p.geo_summary_cn && (
          <section className="mt-6 rounded-2xl border border-ink-line bg-white p-4 md:mt-10 md:p-6">
            <h2 className="flex items-center text-sm font-semibold text-ink md:text-base">
              <span className="mr-2 inline-block h-4 w-1 rounded-full bg-industrial" />
              产品概览
            </h2>
            <p className="mt-2 whitespace-pre-line text-[13px] leading-relaxed text-ink-soft md:mt-3 md:text-sm md:leading-relaxed">
              {p.geo_summary_cn}
            </p>
          </section>
        )}

        {/* 规格参数 - 信息卡 */}
        <section className="mt-6 rounded-2xl border border-ink-line bg-white p-4 md:mt-10 md:p-6">
          <h2 className="flex items-center text-sm font-semibold text-ink md:text-base">
            <span className="mr-2 inline-block h-4 w-1 rounded-full bg-industrial" />
            规格参数
          </h2>
          <div className="mt-3 grid grid-cols-1 gap-x-8 gap-y-0 md:mt-5 md:grid-cols-2">
            {specs
              .filter((s) => s.value)
              .map((s, i) => {
                const Icon = s.icon;
                return (
                  <div
                    key={i}
                    className="flex items-start gap-3 border-b border-ink-line py-2.5 md:py-3"
                  >
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-industrial-50">
                      <Icon className="h-4 w-4 text-industrial" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] text-ink-mute md:text-xs">{s.label}</p>
                      <p className="mt-0.5 text-[13px] text-ink md:text-sm">{s.value}</p>
                    </div>
                  </div>
                );
              })}
          </div>
        </section>

        {/* 相关证书 */}
        {certs.length > 0 && (
          <section className="mt-6 rounded-2xl border border-ink-line bg-white p-4 md:mt-8 md:p-6">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink md:text-base">
                <Award className="h-4 w-4 text-brass" /> 相关证书
              </h2>
              <Link href="/certificates" className="text-[11px] text-industrial md:text-xs">
                全部
              </Link>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 md:mt-5 md:grid-cols-4 md:gap-4">
              {certs.map((c) => (
                <Link
                  key={c.id}
                  href="/certificates"
                  className="overflow-hidden rounded-xl border border-ink-line"
                >
                  <div className="aspect-[3/4]">
                    <ProductImage
                      src={c.image_url}
                      alt={c.name_cn}
                      placeholder="cert"
                    />
                  </div>
                  <p className="line-clamp-1 px-2 py-1.5 text-[10px] text-ink md:text-[11px]">
                    {c.name_cn}
                  </p>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* 常见问题 FAQ */}
        {p.faq_cn && p.faq_cn.length > 0 && (
          <section className="mt-6 rounded-2xl border border-ink-line bg-white p-4 md:mt-8 md:p-6">
            <h2 className="flex items-center text-sm font-semibold text-ink md:text-base">
              <span className="mr-2 inline-block h-4 w-1 rounded-full bg-industrial" />
              常见问题
            </h2>
            <div className="mt-3 space-y-3 md:mt-5 md:space-y-4">
              {p.faq_cn.map((f, i) => (
                <div key={i} className="border-b border-ink-line pb-3 last:border-b-0 last:pb-0 md:pb-4">
                  <h3 className="text-[13px] font-semibold text-ink md:text-sm">
                    {f.question}
                  </h3>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-soft md:mt-1.5 md:text-[13px] md:leading-relaxed">
                    {f.answer}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}
      </ResponsiveContainer>

      {/* mobile 底部固定 CTA */}
      <div className="fixed bottom-0 left-0 z-40 w-full border-t border-ink-line bg-white/95 px-4 py-3 backdrop-blur-lg safe-bottom md:hidden">
        <div className="flex gap-2">
          {companyPhone && (
            <a
              href={`tel:${companyPhone.replace(/[^+\d]/g, "")}`}
              className="flex h-12 w-12 items-center justify-center rounded-xl border border-ink-line text-ink-soft transition hover:border-industrial/30 hover:text-industrial"
              aria-label="电话联系"
            >
              <Phone className="h-5 w-5" />
            </a>
          )}
          <Link href="/contact" className="flex-1">
            <span className="btn-primary flex h-12 w-full items-center justify-center text-sm">
              立即询盘 · Get Quotation
            </span>
          </Link>
        </div>
      </div>

      {/* JSON-LD */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {faqJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
      )}
    </div>
  );
}
