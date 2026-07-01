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
    | Pick<Product, "name_cn" | "name_en" | "summary_cn" | "summary_en" | "cover_image_url">
    | null
    | undefined = null;

  if (isDemoMode()) {
    product = getMockProductBySlug(params.slug) || null;
  } else {
    const supabase = createServerSupabaseClient();
    const { data } = await supabase
      .from("products")
      .select("name_cn, name_en, summary_cn, summary_en, cover_image_url")
      .eq("slug", params.slug)
      .eq("is_published", true)
      .single();
    product = data as typeof product | null;
  }

  if (!product) {
    return { title: "产品未找到" };
  }

  const title = `${product.name_cn} | KZQ`;
  const description = product.summary_cn || product.name_cn;

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
    ...images.map((img) => ({
      url: img.image_url,
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
      priceCurrency: "CNY",
      price: "0",
      availability: "https://schema.org/InStock",
      priceSpecification: {
        "@type": "PriceSpecification",
        priceCurrency: "CNY",
        price: "0",
      },
    },
  };

  return (
    <div className="animate-fade-in bg-canvas pb-24">
      {/* 顶部返回 sticky */}
      <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-ink-line bg-white/95 px-5 py-3 backdrop-blur-lg">
        <Link
          href="/products"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-canvas-warm text-ink-soft transition hover:bg-canvas-cool"
          aria-label="返回"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <span className="line-clamp-1 text-[13px] font-medium text-ink">
          {p.name_cn}
        </span>
      </div>

      {/* 图片轮播 - 视觉重点 */}
      <ImageCarousel images={carouselImages} videoUrl={p.video_url} />

      {/* 标题与卖点 */}
      <div className="bg-white px-5 py-4">
        <div className="flex flex-wrap gap-1.5">
          <FireBadge rating={p.fire_rating || "B级"} />
          <EcoBadge grade={p.eco_grade || "E0级"} />
          {p.is_featured && (
            <span className="chip chip-feature">主推产品</span>
          )}
        </div>
        <h1 className="mt-2 text-lg font-bold leading-snug text-ink">
          {p.name_cn}
        </h1>
        {p.name_en && (
          <p className="mt-0.5 text-[11px] text-ink-mute">{p.name_en}</p>
        )}
        {p.summary_cn && (
          <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
            {p.summary_cn}
          </p>
        )}

        {/* 类目面包屑 */}
        {(cat || sub) && (
          <div className="mt-3 flex flex-wrap items-center gap-1 text-[11px] text-ink-mute">
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

        {/* 价格 - 精致信息卡 */}
        <div className="mt-4 rounded-xl border border-ink-line bg-canvas-warm p-3.5">
          <p className="text-[11px] text-ink-mute">公开价格</p>
          <p className="mt-0.5 text-[15px] font-semibold text-industrial">
            {p.price_display_cn || "请联系销售获取报价"}
          </p>
          {p.price_display_en && (
            <p className="text-[11px] text-ink-mute">{p.price_display_en}</p>
          )}
        </div>
      </div>

      {/* 产品描述 */}
      {p.description_cn && (
        <section className="mt-2 bg-white px-5 py-4">
          <h2 className="flex items-center text-sm font-semibold text-ink">
            <span className="mr-2 inline-block h-4 w-1 rounded-full bg-industrial" />
            产品介绍
          </h2>
          <p className="mt-2 whitespace-pre-line text-[13px] leading-relaxed text-ink-soft">
            {p.description_cn}
          </p>
        </section>
      )}

      {/* 规格参数 - 精致信息卡 */}
      <section className="mt-2 bg-white px-5 py-4">
        <h2 className="flex items-center text-sm font-semibold text-ink">
          <span className="mr-2 inline-block h-4 w-1 rounded-full bg-industrial" />
          规格参数
        </h2>
        <div className="mt-3 divide-y divide-ink-line">
          {specs
            .filter((s) => s.value)
            .map((s, i) => {
              const Icon = s.icon;
              return (
                <div key={i} className="flex items-start gap-3 py-2.5">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-industrial-50">
                    <Icon className="h-4 w-4 text-industrial" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] text-ink-mute">{s.label}</p>
                    <p className="mt-0.5 text-[13px] text-ink">{s.value}</p>
                  </div>
                </div>
              );
            })}
        </div>
      </section>

      {/* 相关证书 */}
      {certs.length > 0 && (
        <section className="mt-2 bg-white px-5 py-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Award className="h-4 w-4 text-brass" /> 相关证书
            </h2>
            <Link href="/certificates" className="text-[11px] text-industrial">
              全部
            </Link>
          </div>
          <div className="mt-3 flex gap-3 overflow-x-auto pb-1 no-scrollbar">
            {certs.map((c) => (
              <Link
                key={c.id}
                href="/certificates"
                className="w-28 shrink-0 overflow-hidden rounded-xl border border-ink-line"
              >
                <div className="aspect-[3/4]">
                  <ProductImage
                    src={c.image_url}
                    alt={c.name_cn}
                    placeholder="cert"
                  />
                </div>
                <p className="line-clamp-1 px-2 py-1.5 text-[10px] text-ink">
                  {c.name_cn}
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* 底部固定 CTA */}
      <div className="fixed bottom-0 left-1/2 z-40 w-full max-w-h5 -translate-x-1/2 border-t border-ink-line bg-white/95 px-5 py-3 backdrop-blur-lg safe-bottom">
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
    </div>
  );
}
