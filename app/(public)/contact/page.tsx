import { ContactPageContent, getContactMetadata } from "@/components/public/pages/ContactPage";
export const revalidate = 300;
export function generateMetadata() { return getContactMetadata("zh"); }
export default function ContactPage({ searchParams }: { searchParams: { product?: string; product_id?: string; product_slug?: string; page_url?: string } }) { return ContactPageContent("zh", searchParams); }
