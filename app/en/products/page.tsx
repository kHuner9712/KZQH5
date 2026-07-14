import { ProductsPageContent, getProductsMetadata, type ProductSearchParams } from "@/components/public/pages/ProductsPage";
export const revalidate = 300;
export function generateMetadata() { return getProductsMetadata("en"); }
export default function EnglishProductsPage({ searchParams }: { searchParams: ProductSearchParams }) { return ProductsPageContent("en", searchParams); }
