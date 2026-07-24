import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ProductForm } from "@/components/admin/ProductForm";
import type { Product, ProductImage } from "@/types/database";

export const dynamic = "force-dynamic";

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();

  const [{ data: product }, { data: images }] = await Promise.all([
    supabase.from("products").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("product_images")
      .select("*")
      .eq("product_id", id)
      .order("sort_order", { ascending: true }),
  ]);

  if (!product) {
    notFound();
  }

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/admin/products"
          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-steel"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> 返回产品列表
        </Link>
        <h1 className="mt-2 text-xl font-bold text-graphite">编辑产品</h1>
        <p className="mt-1 text-sm text-gray-500">
          {(product as Product).name_cn} · slug: {(product as Product).slug}
        </p>
      </div>
      <ProductForm initial={product as Product} initialImages={(images as ProductImage[]) || []} />
    </div>
  );
}
