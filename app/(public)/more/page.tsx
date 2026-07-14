import { MorePageContent, getMoreMetadata } from "@/components/public/UtilityPages";
export const revalidate = 300;
export function generateMetadata() { return getMoreMetadata("zh"); }
export default function MorePage() { return <MorePageContent locale="zh" />; }
