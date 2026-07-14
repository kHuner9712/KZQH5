import { HomePageContent, getHomeMetadata } from "@/components/public/pages/HomePage";
import { renderPublicPage } from "@/components/public/PublicDataUnavailable";
export const revalidate = 300;
export function generateMetadata() { return getHomeMetadata("en"); }
export default function EnglishHomePage() { return renderPublicPage("en", "/en", () => HomePageContent("en")); }
