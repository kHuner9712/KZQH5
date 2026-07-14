import { HomePageContent, getHomeMetadata } from "@/components/public/pages/HomePage";
import { renderPublicPage } from "@/components/public/PublicDataUnavailable";
export const revalidate = 300;
export function generateMetadata() { return getHomeMetadata("zh"); }
export default function HomePage() { return renderPublicPage("zh", "/", () => HomePageContent("zh")); }
