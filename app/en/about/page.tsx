import { AboutPageContent, getAboutMetadata } from "@/components/public/pages/AboutPage";
import { renderPublicPage } from "@/components/public/PublicDataUnavailable";
export const revalidate = 300;
export function generateMetadata() { return getAboutMetadata("en"); }
export default function EnglishAboutPage() { return renderPublicPage("en", "/en/about", () => AboutPageContent("en")); }
