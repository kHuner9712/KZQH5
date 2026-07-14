import { ProductsPageContent, getProductsMetadata, type ProductSearchParams } from "@/components/public/pages/ProductsPage";
export const revalidate = 300;
export function generateMetadata() { return getProductsMetadata("zh"); }
export default function ProductsPage({ searchParams }: { searchParams: ProductSearchParams }) { return ProductsPageContent("zh", searchParams); }
