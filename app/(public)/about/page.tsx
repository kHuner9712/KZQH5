import { AboutPageContent, getAboutMetadata } from "@/components/public/pages/AboutPage";
import { renderPublicPage } from "@/components/public/PublicDataUnavailable";
export const revalidate = 300;
export function generateMetadata() { return getAboutMetadata("zh"); }
export default function AboutPage() { return renderPublicPage("zh", "/about", () => AboutPageContent("zh")); }
