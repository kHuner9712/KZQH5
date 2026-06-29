import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ImageCarousel } from "@/components/public/ImageCarousel";
import { FireBadge, EcoBadge } from "@/components/public/Badge";
import { Button } from "@/components/ui/Button";
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
} from "lucide-react";
import type {
  Product,
  ProductImage,
  Category,
  Subcategory,
  Certificate,
} from "@/types/database";

export const revalidate = 60;

// 不使用 generateStaticParams：构建时无请求作用域，无法调用 cookies()。
// 改为依赖 ISR (revalidate = 60) 按需生成与缓存，首次访问时渲染并缓存 60 秒。
// 同时设置 dynamicParams = true（默认），允许任意 slug 动态渲染。

// 动态 metadata
export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from("products")
    .select("name_cn, name_en, summary_cn, summary_en, cover_image_url")
    .eq("slug", params.slug)
    .eq("is_published", true)
    .single();

  if (!data) {
    return { title: "产品未找到" };
  }

  const title = `${data.name_cn} | KZQ`;
  const description = data.summary_cn || data.name_cn;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: data.cover_image_url ? [{ url: data.cover_image_url }] : [],
      type: "website",
    },
  };
}

export default async function ProductDetailPage({
  params,
}: {
  params: { slug: string };
}) {
  const supabase = createServerSupabaseClient();

  // 查询产品
  const { data: productData } = await supabase
    .from("products")
    .select("*")
    .eq("slug", params.slug)
    .eq("is_published", true)
    .single();

  if (!productData) {
    notFound();
  }

  const product = productData as Product;

  // 并行查询关联数据（含 company_profile 用于读取联系电话）
  const [
    { data: imagesData },
    { data: category },
    { data: subcategory },
    { data: certificates },
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

  const images = (imagesData as ProductImage[] | null) || [];
  const carouselImages = [
    ...(product.cover_image_url
      ? [{ url: product.cover_image_url, alt: product.name_cn }]
      : []),
    ...images.map((img) => ({
      url: img.image_url,
      alt: img.alt_cn || product.name_cn,
    })),
  ];

  const cat = category as Category | null;
  const sub = subcategory as Subcategory | null;
  const certs = (certificates as Certificate[] | null) || [];
  const companyPhone =
    (companyData as { phone: string | null } | null)?.phone || null;

  // 规格表
  const specs: Array<{ icon: typeof Ruler; label: string; value?: string | null }> = [
    { icon: Ruler, label: "规格尺寸", value: product.size },
    { icon: Layers, label: "材质", value: product.material_cn },
    { icon: Package, label: "包装说明", value: product.packaging_cn },
    { icon: Truck, label: "物流说明", value: product.logistics_cn },
    { icon: Boxes, label: "最小起订量", value: product.moq },
    { icon: CheckCircle2, label: "应用场景", value: product.application_cn },
  ];

  // JSON-LD Product
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name_cn,
    description: product.summary_cn || product.description_cn || product.name_cn,
    image: product.cover_image_url ? [product.cover_image_url] : undefined,
    sku: product.slug,
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
    <div className="animate-fade-in pb-24">
      {/* 顶部返回 */}
      <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-gray-100 bg-white/95 px-4 py-3 backdrop-blur-lg">
        <Link
          href="/products"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200"
          aria-label="返回"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <span className="line-clamp-1 text-sm font-medium text-graphite">
          {product.name_cn}
        </span>
      </div>

      {/* 图片轮播 */}
      <ImageCarousel images={carouselImages} videoUrl={product.video_url} />

      {/* 标题与卖点 */}
      <div className="bg-white px-4 py-4">
        <div className="flex flex-wrap gap-1.5">
          <FireBadge rating={product.fire_rating || "B级"} />
          <EcoBadge grade={product.eco_grade || "E0级"} />
          {product.is_featured && (
            <span className="rounded-md bg-gold/15 px-2 py-0.5 text-xs font-medium text-gold-dark ring-1 ring-inset ring-gold/30">
              主推产品
            </span>
          )}
        </div>
        <h1 className="mt-2 text-lg font-bold leading-snug text-graphite">
          {product.name_cn}
        </h1>
        {product.name_en && (
          <p className="mt-0.5 text-xs text-gray-400">{product.name_en}</p>
        )}
        {product.summary_cn && (
          <p className="mt-2 text-sm leading-relaxed text-gray-600">
            {product.summary_cn}
          </p>
        )}

        {/* 类目面包屑 */}
        {(cat || sub) && (
          <div className="mt-3 flex flex-wrap items-center gap-1 text-[11px] text-gray-400">
            <Link href="/products" className="hover:text-steel">产品中心</Link>
            {cat && (
              <>
                <span>/</span>
                <Link
                  href={`/products?category=${cat.slug}`}
                  className="hover:text-steel"
                >
                  {cat.name_cn}
                </Link>
              </>
            )}
            {sub && (
              <>
                <span>/</span>
                <span className="text-gray-600">{sub.name_cn}</span>
              </>
            )}
          </div>
        )}

        {/* 价格 */}
        <div className="mt-4 rounded-xl bg-gradient-to-r from-steel/5 to-gold/5 p-3.5 ring-1 ring-steel/10">
          <p className="text-[11px] text-gray-500">公开价格</p>
          <p className="mt-0.5 text-base font-semibold text-steel">
            {product.price_display_cn || "请联系销售获取报价"}
          </p>
          {product.price_display_en && (
            <p className="text-[11px] text-gray-400">{product.price_display_en}</p>
          )}
        </div>
      </div>

      {/* 产品描述 */}
      {product.description_cn && (
        <section className="mt-2 bg-white px-4 py-4">
          <h2 className="text-sm font-semibold text-graphite">产品介绍</h2>
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-gray-600">
            {product.description_cn}
          </p>
        </section>
      )}

      {/* 规格表 */}
      <section className="mt-2 bg-white px-4 py-4">
        <h2 className="text-sm font-semibold text-graphite">规格参数</h2>
        <div className="mt-3 divide-y divide-gray-100">
          {specs
            .filter((s) => s.value)
            .map((s, i) => {
              const Icon = s.icon;
              return (
                <div key={i} className="flex items-start gap-3 py-2.5">
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-steel/10">
                    <Icon className="h-3.5 w-3.5 text-steel" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] text-gray-400">{s.label}</p>
                    <p className="mt-0.5 text-sm text-graphite">{s.value}</p>
                  </div>
                </div>
              );
            })}
        </div>
      </section>

      {/* 相关证书 */}
      {certs.length > 0 && (
        <section className="mt-2 bg-white px-4 py-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-graphite">
              <Award className="h-4 w-4 text-gold-dark" /> 相关证书
            </h2>
            <Link href="/certificates" className="text-xs text-steel">
              全部
            </Link>
          </div>
          <div className="mt-3 flex gap-3 overflow-x-auto pb-1 no-scrollbar">
            {certs.map((c) => (
              <Link
                key={c.id}
                href="/certificates"
                className="w-32 shrink-0 overflow-hidden rounded-lg ring-1 ring-gray-100"
              >
                <div className="aspect-[3/4] bg-gray-100">
                  {c.image_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={c.image_url}
                      alt={c.name_cn}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  )}
                </div>
                <p className="line-clamp-1 px-2 py-1.5 text-[11px] text-graphite">
                  {c.name_cn}
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* 底部询盘 CTA */}
      <div className="fixed bottom-0 left-1/2 z-40 w-full max-w-h5 -translate-x-1/2 border-t border-gray-100 bg-white/95 px-4 py-3 backdrop-blur-lg safe-bottom">
        <div className="flex gap-2">
          {companyPhone && (
            <a
              href={`tel:${companyPhone.replace(/[^+\d]/g, "")}`}
              className="flex h-12 w-12 items-center justify-center rounded-lg border border-gray-200 text-gray-600"
              aria-label="电话联系"
            >
              <Phone className="h-5 w-5" />
            </a>
          )}
          <Link href="/contact" className="flex-1">
            <Button size="lg" className="w-full">
              立即询盘获取报价
            </Button>
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
