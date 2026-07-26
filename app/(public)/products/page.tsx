import { ProductsPageContent, getProductsMetadata, type ProductSearchParams } from "@/components/public/pages/ProductsPage";
export const revalidate = 300;
export function generateMetadata() { return getProductsMetadata("zh"); }
export default async function ProductsPage({ searchParams }: { searchParams: Promise<ProductSearchParams> }) {
  const resolvedSearchParams = await searchParams;
  return ProductsPageContent("zh", resolvedSearchParams);
}
