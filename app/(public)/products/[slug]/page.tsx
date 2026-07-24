import { ProductDetailPageContent, getProductMetadata } from "@/components/public/pages/ProductDetailPage";
export const revalidate = 300;
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return getProductMetadata("zh", slug);
}
export default async function ProductDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return ProductDetailPageContent("zh", slug);
}
