import { PrivacyPageContent, getPrivacyMetadata } from "@/components/public/UtilityPages";
export const revalidate = 300;
export function generateMetadata() { return getPrivacyMetadata("zh"); }
export default function PrivacyPage() { return <PrivacyPageContent locale="zh" />; }
