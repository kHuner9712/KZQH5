import { ProductsPageContent, getProductsMetadata, type ProductSearchParams } from "@/components/public/pages/ProductsPage";
export const revalidate = 300;
export function generateMetadata() { return getProductsMetadata("en"); }
export default async function EnglishProductsPage({ searchParams }: { searchParams: Promise<ProductSearchParams> }) {
  const resolvedSearchParams = await searchParams;
  return ProductsPageContent("en", resolvedSearchParams);
}
