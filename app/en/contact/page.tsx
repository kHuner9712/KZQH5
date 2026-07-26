import { ContactPageContent, getContactMetadata } from "@/components/public/pages/ContactPage";
export const revalidate = 300;
export function generateMetadata() { return getContactMetadata("en"); }
export default async function EnglishContactPage({ searchParams }: { searchParams: Promise<{ product?: string; product_id?: string; product_slug?: string; page_url?: string }> }) {
  const resolvedSearchParams = await searchParams;
  return ContactPageContent("en", resolvedSearchParams);
}
