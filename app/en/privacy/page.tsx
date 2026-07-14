import { PrivacyPageContent, getPrivacyMetadata } from "@/components/public/UtilityPages";
export const revalidate = 300;
export function generateMetadata() { return getPrivacyMetadata("en"); }
export default function EnglishPrivacyPage() { return <PrivacyPageContent locale="en" />; }
