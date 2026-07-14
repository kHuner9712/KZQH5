import { ProductDetailPageContent, getProductMetadata } from "@/components/public/pages/ProductDetailPage";
export const revalidate = 300;
export function generateMetadata({ params }: { params: { slug: string } }) { return getProductMetadata("zh", params.slug); }
export default function ProductDetailPage({ params }: { params: { slug: string } }) { return ProductDetailPageContent("zh", params.slug); }
