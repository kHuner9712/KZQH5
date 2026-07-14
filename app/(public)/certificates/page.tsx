import { CertificatesPageContent, getCertificatesMetadata } from "@/components/public/pages/CertificatesPage";
import { renderPublicPage } from "@/components/public/PublicDataUnavailable";
export const revalidate = 300;
export function generateMetadata() { return getCertificatesMetadata("zh"); }
export default function CertificatesPage() { return renderPublicPage("zh", "/certificates", () => CertificatesPageContent("zh")); }
