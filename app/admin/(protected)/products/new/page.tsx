import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { ProductForm } from "@/components/admin/ProductForm";

export default function NewProductPage() {
  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/admin/products"
          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-steel"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> 返回产品列表
        </Link>
        <h1 className="mt-2 text-xl font-bold text-graphite">新增产品</h1>
        <p className="mt-1 text-sm text-gray-500">
          填写产品中英文信息、规格、媒体资源，默认防火 B级 / 环保 E0级
        </p>
      </div>
      <ProductForm />
    </div>
  );
}
