import { MorePageContent, getMoreMetadata } from "@/components/public/UtilityPages";
export const revalidate = 300;
export function generateMetadata() { return getMoreMetadata("en"); }
export default function EnglishMorePage() { return <MorePageContent locale="en" />; }
