import { ProductDetailPageContent, getProductMetadata } from "@/components/public/pages/ProductDetailPage";
export const revalidate = 300;
export function generateMetadata({ params }: { params: { slug: string } }) { return getProductMetadata("en", params.slug); }
export default function EnglishProductDetailPage({ params }: { params: { slug: string } }) { return ProductDetailPageContent("en", params.slug); }
